"""tunnel_client.py — เปิดท่อขาออกไปหา central ค้างไว้ ให้ central ใช้ Qdrant และผู้ให้บริการ AI ในวงของเครื่องนี้
(LAN/VPN) ได้โดยไม่ต้องเปิดพอร์ต

ความปลอดภัย: ส่งต่อได้เฉพาะ Qdrant API ไปที่ URL ของ Qdrant ที่ตั้งไว้ในเครื่องนี้ และเฉพาะ API ของ AI
(chat/embeddings/rerank/ถอดเสียง) ไปที่การเชื่อมต่อในวงที่ตั้งไว้ใน node เท่านั้น (central สั่งให้ไปที่อื่นใน LAN
ไม่ได้) และ key ใส่ที่ฝั่งนี้ ไม่เคยส่งไป central
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import threading
import time
from typing import Callable

import httpx

_log = logging.getLogger("node.tunnel")

# path ที่ qdrant-client ใช้ — นอกจากนี้ปฏิเสธหมด
_ALLOWED_PATH = re.compile(r"^/(collections(/.*)?|aliases(/.*)?)?$")
_ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
_MAX_MESSAGE = 128 * 1024 * 1024
# ผู้ให้บริการ AI: /p/<id การเชื่อมต่อ>/<endpoint แบบ OpenAI ที่สูตรใช้> — นอกจากนี้ปฏิเสธหมด
_PROVIDER_PATH = re.compile(r"^/p/([\w-]+)(/(?:chat/completions|completions|embeddings|rerank|audio/transcriptions|models))$")
_PROVIDER_DROP_HEADERS = {"authorization", "host", "content-length", "connection", "transfer-encoding",
                          "accept-encoding", "keep-alive", "upgrade", "cookie"}
_PROVIDER_MAX_WAIT = 1800


class TunnelClient:
    def __init__(self, central_url: Callable[[], str], token: Callable[[bool], str],
                 target: Callable[[], tuple[str, str | None]], verify=True,
                 on_line: Callable[[dict], dict] | None = None, on_api: Callable[[dict], dict] | None = None,
                 provider: Callable[[str], tuple[str, str] | None] | None = None):
        self._on_line = on_line
        self._on_api = on_api
        self._provider = provider
        self._central_url = central_url
        self._token = token
        self._target = target
        self._verify = verify
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._ws = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.state = {"status": "stopped", "since": None, "error": None}

    # ── ควบคุม ──
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=lambda: asyncio.run(self._run()), name="central-tunnel", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._set("stopped")
        self._close_ws()

    def reconnect(self) -> None:
        """เปลี่ยน central/license แล้ว — ตัดเส้นเดิม (ยังต่อกับ central/license ตัวเก่า) ให้วนต่อใหม่ด้วยค่าใหม่ทันที"""
        self._close_ws()

    def _close_ws(self) -> None:
        ws, loop = self._ws, self._loop
        if ws is not None and loop is not None and loop.is_running():
            asyncio.run_coroutine_threadsafe(ws.close(), loop)

    def _set(self, status: str, error: str | None = None) -> None:
        if self.state["status"] != status or self.state["error"] != error:
            self.state = {"status": status, "since": time.time(), "error": error}

    # ── วนเชื่อมต่อใหม่จนกว่าจะสั่งหยุด ──
    async def _run(self) -> None:
        import websockets
        self._loop = asyncio.get_running_loop()
        delay, force_token = 1.0, False
        while not self._stop.is_set():
            self._set("connecting", self.state.get("error"))
            try:
                token = await asyncio.to_thread(self._token, force_token)
                url = re.sub(r"^http", "ws", self._central_url().rstrip("/")) + "/v1/tunnel"
                # ไม่ใส่ ssl= เลยถ้าไม่ได้ปักหมุด CA เอง — websockets รุ่นใหม่ปฏิเสธ ssl=None กับ wss:// ทันที
                # (มองว่าขัดกับ scheme ที่ขอ TLS) ปล่อยให้มันสร้าง default SSLContext ของตัวเองสำหรับ wss://
                connect_kwargs = {}
                if url.startswith("wss://") and self._verify is not True:
                    import ssl
                    connect_kwargs["ssl"] = (ssl.create_default_context(cafile=self._verify)
                                             if isinstance(self._verify, str) else ssl.create_default_context())
                async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {token}"},
                                              max_size=_MAX_MESSAGE, ping_interval=20, ping_timeout=20,
                                              open_timeout=15, **connect_kwargs) as ws:
                    self._ws = ws
                    self._set("connected")
                    delay, force_token = 1.0, False
                    try:
                        await self._serve(ws)
                    finally:
                        self._ws = None
            except Exception as e:  # noqa: BLE001 — วนต่อเสมอ แค่จำสาเหตุล่าสุดไว้แสดงในหลังบ้าน
                code = getattr(getattr(e, "rcvd", None), "code", None)
                if code == 4401:
                    force_token = True  # token หมดอายุ/ถูกระงับ — ขอใหม่รอบหน้า
                if code == 4409:
                    self._set("replaced", "license นี้ถูกเปิดท่อจากเครื่องอื่นล่าสุด")
                else:
                    self._set("connecting", f"{type(e).__name__}: {e}"[:200])
            if self._stop.wait(delay):
                break
            delay = min(delay * 2, 30.0)

    async def _serve(self, ws) -> None:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as client:
            tasks: set[asyncio.Task] = set()
            send_lock = asyncio.Lock()

            async def handle(msg: dict):
                async def send(frame: dict):
                    async with send_lock:
                        await ws.send(json.dumps({**frame, "id": msg.get("id")}))

                if msg.get("op") == "provider":
                    await self._forward_provider(client, msg, send)
                    return
                await send(await self._forward(client, msg))

            async for raw in ws:
                if self._stop.is_set():
                    break
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                t = asyncio.create_task(handle(msg))
                tasks.add(t)
                t.add_done_callback(tasks.discard)

    async def _forward(self, client: httpx.AsyncClient, msg: dict) -> dict:
        if msg.get("op") == "line" and self._on_line:
            # webhook ของ LINE ที่ central ส่งต่อมา — ตรวจลายเซ็นแล้วตอบรับทันที (คำตอบประมวลผลทีหลังใน thread)
            return await asyncio.to_thread(self._on_line, msg)
        if msg.get("op") == "api" and self._on_api:
            # คำขอ API จากระบบภายนอก (n8n ฯลฯ) ที่ central relay ส่งต่อมา — node ตรวจ API key เองแล้วตอบ status + JSON
            return await asyncio.to_thread(self._on_api, msg)
        if msg.get("op") != "http":
            return {"error": "unsupported op"}
        method, path = str(msg.get("method", "")).upper(), str(msg.get("path", ""))
        segments = path.split("/")
        if (method not in _ALLOWED_METHODS or not _ALLOWED_PATH.match(path) or "//" in path or "%" in path
                or any(seg in (".", "..") for seg in segments)):
            return {"error": "path not allowed"}
        base, api_key = self._target()
        if not base:
            return {"error": "ยังไม่ได้ตั้ง Qdrant ในเครื่องนี้"}
        headers = {k: v for k, v in (msg.get("headers") or {}).items() if k.lower() == "content-type"}
        if api_key:
            headers["api-key"] = api_key
        query = msg.get("query") or ""
        try:
            resp = await client.request(method, base.rstrip("/") + path + (f"?{query}" if query else ""),
                                        content=base64.b64decode(msg.get("body") or ""), headers=headers)
        except httpx.HTTPError as e:
            return {"error": f"ติดต่อ Qdrant ในเครื่องไม่ได้ ({type(e).__name__})"}
        return {"status": resp.status_code,
                "headers": {k: v for k, v in resp.headers.items() if k.lower() == "content-type"},
                "body": base64.b64encode(resp.content).decode()}

    async def _forward_provider(self, client: httpx.AsyncClient, msg: dict, send) -> None:
        """คำขอไปผู้ให้บริการ AI ในวงของเครื่องนี้ที่ central ขอผ่านท่อ — ตอบกลับเป็นช่วง ๆ
        (head → chunk … → end) ให้หน้าแชทแสดงคำตอบทีละคำได้เหมือน central เรียกตรง"""
        method, path = str(msg.get("method", "")).upper(), str(msg.get("path", ""))
        m = _PROVIDER_PATH.match(path)
        if method not in ("GET", "POST") or not m or "%" in path:
            await send({"error": "path not allowed"})
            return
        target = self._provider(m.group(1)) if self._provider else None
        if not target:
            await send({"error": "ไม่พบการเชื่อมต่อในวงนี้บน node"})
            return
        base, key = target
        headers = {k: v for k, v in (msg.get("headers") or {}).items() if k.lower() not in _PROVIDER_DROP_HEADERS}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        query = msg.get("query") or ""
        wait = min(float(msg.get("timeout") or _PROVIDER_MAX_WAIT), _PROVIDER_MAX_WAIT)
        try:
            async with client.stream(method, base.rstrip("/") + m.group(2) + (f"?{query}" if query else ""),
                                     content=base64.b64decode(msg.get("body") or ""), headers=headers,
                                     timeout=httpx.Timeout(wait, connect=10)) as resp:
                await send({"status": resp.status_code,
                            "headers": {k: v for k, v in resp.headers.items() if k.lower() == "content-type"}})
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        await send({"chunk": base64.b64encode(chunk).decode()})
            await send({"end": True})
        except httpx.HTTPError as e:
            await send({"error": f"ติดต่อผู้ให้บริการในวงไม่ได้ ({type(e).__name__})"})
        except Exception as e:  # noqa: BLE001 — ตอบ error เสมอ ไม่ให้ central รอจนหมดเวลา
            try:
                await send({"error": f"{type(e).__name__}"})
            except Exception:
                pass
