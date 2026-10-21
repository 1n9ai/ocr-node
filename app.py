"""app.py — 1n9 OCR: อ่านเอกสารด้วยเอนจิน 1n9 AI (central) ตรวจตามกฎ เก็บรายการที่ถูกต้องไว้ที่เครื่องนี้ และแจ้งเตือนผ่าน LINE

หน้าที่:
- เก็บการตั้งค่า (การเชื่อมต่อ AI / คลังโมเดล / central / LINE) ใน SQLite — key เข้ารหัสด้วย Fernet
- ส่งไฟล์ให้ central อ่าน (central ไม่เก็บอะไร) แล้วตรวจผลตามกฎด้วยโค้ด เก็บรายการไว้ที่เครื่องนี้ (ไม่เก็บไฟล์ต้นฉบับ)
- เสิร์ฟหน้าเว็บ (frontend/out — Next.js static export)

ข้อความ error ทุกตัวมีรหัส (detail.code) ให้หน้าเว็บแปลเป็นภาษาที่ผู้ใช้เลือก ข้อความใน detail.message เป็นภาษาอังกฤษสำรอง
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import ssl
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from tunnel_client import TunnelClient

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DATA_DIR = Path(os.environ.get("NODE_DATA_DIR") or ROOT / "data")
DB_FILE = DATA_DIR / "node.db"
SECRET_KEY_FILE = DATA_DIR / "secret.key"
# รหัสเครื่องนี้ (สุ่มครั้งแรกครั้งเดียว) — central ใช้ผูก license กับเครื่องล่าสุดที่ใช้ (กันแชร์ key)
INSTALL_ID_FILE = DATA_DIR / "install_id"
FRONTEND_DIR = Path(os.environ.get("NODE_FRONTEND_DIR") or ROOT / "frontend" / "out")

NODE_USER = os.environ.get("NODE_USER", "admin")
NODE_PASSWORD = os.environ.get("NODE_PASSWORD", "")


TIMEOUT = httpx.Timeout(connect=15, read=900, write=120, pool=15)


def err(status: int, code: str, message: str, **params) -> HTTPException:
    """error ที่หน้าเว็บแปลได้: detail = {code, message (อังกฤษสำรอง), params}"""
    return HTTPException(status, {"code": code, "message": message, "params": params})

app = FastAPI(title="1n9 OCR", docs_url=None, redoc_url=None, openapi_url=None)


# ══════════════════════════════════════════════
# เข้าสู่ระบบ: หน้า login (session cookie) + Basic Auth สำหรับสคริปต์/API (เปิดเมื่อมีรหัสผ่านแล้วเท่านั้น)
# รหัสผ่านมาจาก NODE_PASSWORD (ไฟล์ตั้งค่า) หรือที่ตั้งในหน้าตั้งค่าครั้งแรก (เก็บแบบ hash)
# ยังไม่มีรหัสเลย = ไม่ล็อก (เครื่องของตัวเอง) — หน้าตั้งค่าครั้งแรกจะให้ตั้งรหัสเป็นขั้นแรก
# ══════════════════════════════════════════════

SESSION_COOKIE = "n_session"
SESSION_TTL = 7 * 24 * 3600
_LOGIN_FAILS: dict[str, list[float]] = {}
_LOGIN_MAX, _LOGIN_WINDOW = 8, 600  # ผิดได้ 8 ครั้ง / 10 นาที ต่อ IP


def _hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()
    return f"pbkdf2_sha256$200000${salt}${digest}"


def _check_password(pw: str, stored: str) -> bool:
    try:
        _, rounds, salt, digest = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(rounds)).hex()
        return secrets.compare_digest(got, digest)
    except (ValueError, TypeError):
        return False


def _stored_password_hash() -> str:
    try:
        return (load_settings().get("setup") or {}).get("password_hash") or ""
    except Exception:  # ฐานข้อมูลยังไม่พร้อม (ก่อน startup) — ยังไม่มีรหัส
        return ""


def _credentials_set() -> bool:
    return bool(NODE_PASSWORD or _stored_password_hash())


def _password_mark() -> str:
    """เปลี่ยนรหัสผ่านแล้ว session เก่าต้องใช้ไม่ได้ — ผูกลายเซ็นกับรหัสปัจจุบัน"""
    return hashlib.sha256((NODE_PASSWORD or _stored_password_hash()).encode()).hexdigest()[:16]


def _sign(payload: str) -> str:
    key = hashlib.sha256(b"session|" + _secret_text().encode()).digest()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def _make_session() -> str:
    exp = int(time.time()) + SESSION_TTL
    payload = f"{exp}|{_password_mark()}"
    return f"{payload}|{_sign(payload)}"


def _session_ok(token: str) -> bool:
    try:
        exp, mark, sig = token.split("|")
        return int(exp) > time.time() and secrets.compare_digest(mark, _password_mark()) and secrets.compare_digest(sig, _sign(f"{exp}|{mark}"))
    except (ValueError, AttributeError):
        return False


def _basic_ok(header: str) -> bool:
    if not header.lower().startswith("basic "):
        return False
    try:
        user, _, pw = base64.b64decode(header[6:]).decode().partition(":")
    except Exception:
        return False
    stored = "" if NODE_PASSWORD else _stored_password_hash()
    return secrets.compare_digest(user, NODE_USER) and (
        secrets.compare_digest(pw, NODE_PASSWORD) if NODE_PASSWORD else bool(stored) and _check_password(pw, stored))


def _authed(request: Request) -> bool:
    return _session_ok(request.cookies.get(SESSION_COOKIE, "")) or _basic_ok(request.headers.get("authorization", ""))


def _set_session_cookie(response: Response, request: Request) -> None:
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https"
    response.set_cookie(SESSION_COOKIE, _make_session(), max_age=SESSION_TTL, httponly=True, samesite="lax", secure=secure, path="/")


def _client_ip(request: Request) -> str:
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    path = request.url.path
    if _credentials_set() and _needs_password(request.method, path) and not _authed(request):
        if path.startswith("/api/"):
            # ไม่ส่ง WWW-Authenticate กลับ เพื่อไม่ให้เบราว์เซอร์เด้งกล่องรหัสผ่านทับหน้า login (สคริปต์ที่ส่ง Basic มาเองยังใช้ได้)
            return JSONResponse({"detail": {"code": "login_required", "message": "Sign in required", "params": {}}}, status_code=401)
        return RedirectResponse("/login/?next=" + quote(path), status_code=302)
    return await call_next(request)


@app.post("/api/auth/login")
async def auth_login(request: Request, body: dict = Body(...)):
    ip = _client_ip(request)
    now = time.time()
    fails = [t for t in _LOGIN_FAILS.get(ip, []) if now - t < _LOGIN_WINDOW]
    if len(fails) >= _LOGIN_MAX:
        raise err(429, "login_rate_limited", "Too many attempts. Try again in a few minutes.")
    user, pw = str(body.get("username") or ""), str(body.get("password") or "")
    stored = "" if NODE_PASSWORD else _stored_password_hash()
    ok = _credentials_set() and secrets.compare_digest(user, NODE_USER) and (
        secrets.compare_digest(pw, NODE_PASSWORD) if NODE_PASSWORD else _check_password(pw, stored))
    if not ok:
        _LOGIN_FAILS[ip] = fails + [now]
        raise err(401, "login_invalid", "Wrong username or password")
    _LOGIN_FAILS.pop(ip, None)
    resp = JSONResponse({"ok": True})
    _set_session_cookie(resp, request)
    return resp


@app.post("/api/auth/logout")
def auth_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.get("/api/auth/me")
def auth_me(request: Request):
    required = _credentials_set()
    return {"auth_required": required, "authenticated": (not required) or _authed(request), "user": NODE_USER if required else None}


# ทุกหน้าต้องเข้าสู่ระบบ (เอกสารที่ตรวจอาจเป็นข้อมูลภายใน) ยกเว้นหน้า login, ไฟล์หน้าเว็บที่ไม่มีข้อมูล และ healthcheck
_OPEN_PREFIXES = ("/healthz", "/login", "/api/auth/", "/_next/", "/brand/", "/icon.png", "/apple-icon.png", "/favicon")


def _needs_password(method: str, path: str) -> bool:
    return not path.startswith(_OPEN_PREFIXES)


@app.middleware("http")
async def no_cache_html(request: Request, call_next):
    """ห้ามเบราว์เซอร์จำหน้า HTML/API — ไม่งั้นหลังอัปเดตเวอร์ชันจะยังเห็นหน้าเก่าจนกว่าจะกด Ctrl+F5
    (ไฟล์ใน /_next/static มีชื่อเปลี่ยนทุก build อยู่แล้ว จึง cache ได้ตามปกติ)"""
    static_asset = request.url.path.startswith("/_next/static/")
    if not static_asset:
        # ตัด header ขอ 304 ทิ้ง — StaticFiles ตัดสิน "ไม่เปลี่ยน" จากเวลาไฟล์ ซึ่งผิดได้กับไฟล์ที่ build ใน
        # Docker (เคยเจอ: เบราว์เซอร์ได้ 304 แล้วแสดงหน้า /chat/ รุ่นเก่าค้าง แม้กดรีเฟรช)
        request.scope["headers"] = [
            (k, v) for k, v in request.scope["headers"] if k not in (b"if-none-match", b"if-modified-since")
        ]
    response = await call_next(request)
    if not static_asset:
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


# ══════════════════════════════════════════════
# SQLite — เก็บแต่ละรายการเป็น JSON ต่อแถว (ตารางละประเภท)
# ══════════════════════════════════════════════

_TABLES = ("docs", "rules")
_db_lock = threading.RLock()


@contextmanager
def _db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE, timeout=15)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _db_lock, _db() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        for t in _TABLES:
            c.execute(f"CREATE TABLE IF NOT EXISTS {t} (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        c.execute("CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)")


def db_all(table: str) -> list[dict]:
    with _db() as c:
        return [json.loads(r[0]) for r in c.execute(f"SELECT data FROM {table} ORDER BY rowid")]


def db_get(table: str, item_id: str) -> dict | None:
    with _db() as c:
        row = c.execute(f"SELECT data FROM {table} WHERE id=?", (item_id,)).fetchone()
    return json.loads(row[0]) if row else None


def db_put(table: str, item_id: str, obj: dict) -> None:
    with _db_lock, _db() as c:
        c.execute(
            f"INSERT INTO {table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            (item_id, json.dumps(obj, ensure_ascii=False)),
        )


def db_delete(table: str, item_id: str) -> None:
    with _db_lock, _db() as c:
        c.execute(f"DELETE FROM {table} WHERE id=?", (item_id,))


_USAGE_ZERO = {"llm_input_tokens": 0, "llm_output_tokens": 0, "llm_calls": 0,
               "embed_tokens": 0, "embed_calls": 0, "rerank_calls": 0, "stt_calls": 0, "stt_seconds": 0.0,
               "requests": 0}


def get_usage() -> dict:
    with _db() as c:
        row = c.execute("SELECT data FROM usage WHERE id=1").fetchone()
    return {**_USAGE_ZERO, **(json.loads(row[0]) if row else {})}


def add_usage(usage: dict | None) -> None:
    if not usage:
        return
    with _db_lock:
        u = get_usage()
        llm, emb, rr = usage.get("llm") or {}, usage.get("embedding") or {}, usage.get("rerank") or {}
        u["llm_input_tokens"] += int(llm.get("input_tokens") or 0)
        u["llm_output_tokens"] += int(llm.get("output_tokens") or 0)
        u["llm_calls"] += int(llm.get("calls") or 0)
        u["embed_tokens"] += int(emb.get("tokens") or 0)
        u["embed_calls"] += int(emb.get("calls") or 0)
        u["rerank_calls"] += int(rr.get("calls") or 0)
        stt = usage.get("stt") or {}
        u["stt_calls"] += int(stt.get("calls") or 0)
        u["stt_seconds"] = round(u["stt_seconds"] + float(stt.get("audio_seconds") or 0), 2)
        u["requests"] += 1
        with _db() as c:
            c.execute("INSERT INTO usage (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                      (json.dumps(u),))


# ══════════════════════════════════════════════
# Settings — การเชื่อมต่อ + คลังโมเดล (key เข้ารหัส, แก้จากหน้าเว็บ, มีผลทันที)
# ══════════════════════════════════════════════
#
# providers  = การเชื่อมต่อที่ผู้ใช้เพิ่มเอง {id: {name, type, base_url, api_key}}
# registry   = คลังโมเดล {id: {name, kind (llm|embedding|rerank|stt), provider, model, dim?}} — เพิ่มได้หลายตัวต่อประเภท
# defaults   = ค่าเริ่มต้นต่อประเภท {llm: id, embedding: id, rerank: id, stt: id}
# stt (ถอดเสียง) ไม่บังคับ — ถ้าไม่มี ใช้ LLM ของบอทถอดแทนได้เมื่อเป็น Gemini
# การเลือกใช้จริงอยู่ที่งาน: KB เลือก embedding ตอนสร้าง (ผูกถาวร), บอทเลือก LLM/rerank (ว่าง = ค่าเริ่มต้น)

SECTIONS = ("providers", "registry", "defaults", "vector", "central", "setup", "notify")
# vector database ที่เก็บเอกสารของ KB — pgvector เก็บ connection string ไว้ในช่อง api_key (มีรหัสผ่านอยู่ข้างใน
# จึงต้องเข้ารหัสและซ่อนแบบเดียวกับ key อื่น) ส่วน Pinecone ใช้แค่ API key
VECTOR_TYPES = ("local", "qdrant", "pgvector", "pinecone")
LEGACY_SECTIONS = ("llm", "embedding", "rerank", "models")
KINDS = ("llm", "embedding", "rerank")
LEGACY_KINDS = ("llm", "embedding", "rerank")  # การตั้งค่ารุ่นแรก (ยังไม่มี stt)
KIND_LABEL = {"llm": "LLM", "embedding": "Embedding", "rerank": "Rerank", "stt": "Speech-to-Text"}
SECRET_FIELDS = {"api_key", "license_key"}
_settings_cache: dict | None = None

# รูปแบบ API ที่ระบบคุยได้ (ระบบเดาจาก URL ให้เอง) — ผู้ให้บริการแทบทุกเจ้าใช้แบบ OpenAI ได้
PROTOCOLS: dict[str, dict] = {
    "openai_compatible": {"label": "OpenAI-compatible API"},
    "google": {"label": "Google Gemini API"},
    "ollama": {"label": "Ollama"},
}

# สำหรับแปลงการตั้งค่ารุ่นแรก ๆ ที่ผูก id ตายตัว
_LEGACY_PROVIDERS = {
    "google": ("Google Gemini", "google", ""),
    "openai": ("OpenAI", "openai_compatible", "https://api.openai.com/v1"),
    "siliconflow": ("SiliconFlow", "openai_compatible", "https://api.siliconflow.com/v1"),
    "ollama": ("Ollama", "ollama", ""),
    "custom": ("OpenAI-compatible", "openai_compatible", ""),
}


def _secret_text() -> str:
    key = os.environ.get("NODE_SECRET_KEY", "").strip()
    if not key:
        if not SECRET_KEY_FILE.exists():
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            SECRET_KEY_FILE.write_bytes(Fernet.generate_key())
            try:
                os.chmod(SECRET_KEY_FILE, 0o600)
            except OSError:
                pass
        key = SECRET_KEY_FILE.read_text().strip()
    return key


def _fernet() -> Fernet:
    return Fernet(_secret_text().encode())


def install_id() -> str:
    if not INSTALL_ID_FILE.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        INSTALL_ID_FILE.write_text(uuid.uuid4().hex)
    return INSTALL_ID_FILE.read_text().strip()


def _enc(value: str) -> str:
    return "enc:" + _fernet().encrypt(value.encode()).decode() if value else ""


def _dec(value: str) -> str:
    if not value or not value.startswith("enc:"):
        return value or ""
    try:
        return _fernet().decrypt(value[4:].encode()).decode()
    except InvalidToken:
        return ""


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


# ── แปลงการตั้งค่ารุ่นก่อน ────────────────────────────

def _provider_id_for(cfg: dict) -> str:
    provider = (cfg.get("provider") or "").lower()
    base = (cfg.get("base_url") or "").lower()
    if provider in ("google", "ollama"):
        return provider
    if "siliconflow" in base:
        return "siliconflow"
    if "api.openai.com" in base:
        return "openai"
    return "custom"


def _from_role_schema(old: dict) -> dict:
    """รุ่นแรก (llm/embedding/rerank แยกกันพร้อม key ในตัว) → providers + models (รุ่นที่สอง)"""
    providers = {pid: {"api_key": "", "base_url": ""} for pid in _LEGACY_PROVIDERS}
    models: dict = {}
    for role in LEGACY_KINDS:
        cfg = old.get(role) or {}
        pid = _provider_id_for(cfg) if (cfg.get("base_url") or role != "rerank") else "siliconflow"
        if role == "rerank" and pid not in ("siliconflow", "custom"):
            pid = "custom"
        if cfg.get("api_key"):
            providers[pid]["api_key"] = cfg["api_key"]
        if pid in ("ollama", "custom") and cfg.get("base_url"):
            providers[pid]["base_url"] = cfg["base_url"]
        models[role] = {"provider": pid, "model": cfg.get("model", "")}
    models["embedding"]["dim"] = int((old.get("embedding") or {}).get("dim") or 0)
    return {"providers": providers, "models": models,
            "vector": old.get("vector") or {"url": "", "api_key": ""},
            "central": old.get("central") or {"url": "", "license_key": ""}}


def _upgrade_providers(providers: dict, used: set) -> dict:
    """providers รุ่นที่ผูก id ตายตัว (ไม่มี type) → การเชื่อมต่อแบบ dynamic — คง id เดิมไว้"""
    out = {}
    for pid, prov in providers.items():
        if "type" in prov:
            out[pid] = prov
            continue
        name, typ, base = _LEGACY_PROVIDERS.get(pid, (pid, "openai_compatible", ""))
        if not (prov.get("api_key") or prov.get("base_url")) and pid not in used:
            continue
        out[pid] = {"name": name, "type": typ, "base_url": prov.get("base_url") or base, "api_key": prov.get("api_key", "")}
    return out


def _models_to_registry(models: dict) -> tuple[dict, dict]:
    """models รุ่นที่สอง (1 ตัวต่อหน้าที่) → คลังโมเดล + ค่าเริ่มต้น"""
    registry: dict = {}
    defaults: dict = {k: None for k in KINDS}
    for kind in KINDS:
        m = models.get(kind) or {}
        if not m.get("model"):
            continue
        mid = f"m_{_new_id()[:8]}"
        entry = {"name": m["model"], "kind": kind, "provider": m.get("provider", ""), "model": m["model"]}
        if kind == "embedding":
            entry["dim"] = int(m.get("dim") or 0)
        registry[mid] = entry
        defaults[kind] = mid
    return registry, defaults


def _to_current(old_rows: dict) -> dict:
    """รับการตั้งค่ารุ่นใดก็ได้ (ถอดรหัสแล้ว) → รูปแบบปัจจุบัน"""
    if "llm" in old_rows:
        old_rows = _from_role_schema(old_rows)
    if "models" in old_rows and "registry" not in old_rows:
        registry, defaults = _models_to_registry(old_rows["models"])
    else:
        registry, defaults = old_rows.get("registry", {}), old_rows.get("defaults", {})
    used = {e.get("provider") for e in registry.values()}
    return {
        "providers": _upgrade_providers(old_rows.get("providers", {}), used),
        "registry": registry,
        "defaults": {k: defaults.get(k) for k in KINDS},
        "vector": old_rows.get("vector") or {"url": "", "api_key": ""},
        "central": old_rows.get("central") or {"url": "", "license_key": ""},
    }


def _guess_vector_type(url: str) -> str:
    """ไม่ได้ระบุ VECTOR_TYPE: Qdrant ที่อยู่เครื่องเดียวกัน/ใน docker/วง LAN → local (ผ่านท่อ เพราะ central เข้าไม่ถึง)
    นอกนั้น (เช่น Qdrant Cloud) → qdrant ต่อตรง"""
    host = (urlparse(url).hostname or "").lower() if url else ""
    if not host:
        return "qdrant"
    if host == "localhost" or "." not in host:
        return "local"
    try:
        return "local" if not ipaddress.ip_address(host).is_global else "qdrant"
    except ValueError:
        return "qdrant"


def _defaults_from_env() -> dict:
    """ค่าเริ่มต้นครั้งแรกจาก .env — ว่าง = ไปตั้งที่หน้าตั้งค่าครั้งแรก (ไม่มีผู้ให้บริการหรือโมเดลตั้งไว้ให้)"""
    return _to_current({
        "llm": {"provider": _env("LLM_PROVIDER") or detect_type(_env("LLM_BASE_URL")), "model": _env("LLM_MODEL"),
                "api_key": _env("LLM_API_KEY"), "base_url": _env("LLM_BASE_URL")},
        "embedding": {"provider": _env("EMBED_PROVIDER") or detect_type(_env("EMBED_BASE_URL")),
                      "model": _env("EMBED_MODEL"),
                      "api_key": _env("EMBED_API_KEY"), "base_url": _env("EMBED_BASE_URL"),
                      "dim": int(_env("EMBED_DIM") or 0)},
        "rerank": {"api_key": _env("RERANK_API_KEY"),
                   "model": _env("RERANK_MODEL") if _env("RERANK_API_KEY") else "",
                   "base_url": _env("RERANK_BASE_URL")},
        "vector": {"type": _env("VECTOR_TYPE") or _guess_vector_type(_env("QDRANT_URL")), "url": _env("QDRANT_URL"),
                   "api_key": _env("QDRANT_API_KEY")},
        "central": {"url": _env("CENTRAL_URL", "https://central.1n9ai.com"), "license_key": _env("LICENSE_KEY")},
    })


# ── อ่าน/เขียน ───────────────────────────────────────

def _secret_map(section: str, values: dict, fn) -> dict:
    if section == "providers":
        return {pid: {k: (fn(v) if k in SECRET_FIELDS else v) for k, v in prov.items()} for pid, prov in values.items()}
    if section in ("registry", "defaults", "models"):
        return values
    return {k: (fn(v) if k in SECRET_FIELDS else v) for k, v in values.items()}


def _write_settings(settings: dict) -> None:
    global _settings_cache
    with _db_lock, _db() as c:
        for section in SECTIONS:
            c.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (section, json.dumps(_secret_map(section, settings.get(section) or {}, _enc), ensure_ascii=False)))
        c.execute(f"DELETE FROM settings WHERE key IN ({','.join('?' * len(LEGACY_SECTIONS))})", LEGACY_SECTIONS)
    _settings_cache = None


def load_settings() -> dict:
    """การตั้งค่าแบบถอดรหัสแล้ว (ใช้ภายใน node เท่านั้น ห้ามส่ง key ออกไปหน้าเว็บ)"""
    global _settings_cache
    if _settings_cache is not None:
        return _settings_cache
    with _db() as c:
        rows = dict(c.execute("SELECT key, value FROM settings").fetchall())
    if not rows:
        _write_settings(_defaults_from_env())
        return load_settings()
    decoded = {k: _secret_map(k, json.loads(v), _dec) for k, v in rows.items()}
    if any(k in decoded for k in LEGACY_SECTIONS) or "registry" not in decoded:
        _write_settings(_to_current(decoded))
        return load_settings()
    settings = {s: decoded.get(s, {}) for s in SECTIONS}
    settings["defaults"] = {k: settings["defaults"].get(k) for k in KINDS}
    for section, secret in (("vector", "api_key"), ("central", "license_key")):
        settings[section].setdefault("url", "")
        settings[section].setdefault(secret, "")
    settings["vector"].setdefault("type", "qdrant")
    settings["notify"] = {"enabled": False, "api_key": "", "recipients": [], "template": "", **settings.get("notify", {})}
    if (old_to := settings["notify"].pop("to", "")) and not settings["notify"]["recipients"]:  # รุ่นก่อนเก็บเป็นข้อความเดียว
        settings["notify"]["recipients"] = [{"rid": _new_id(), "id": i, "name": ""} for i in re.split(r"[\s,;]+", old_to) if _LINE_ID_RE.match(i)][:NOTIFY_MAX_RECIPIENTS]
    _settings_cache = settings
    return settings


# ── ส่งออกให้หน้าเว็บ (ไม่มี key) ─────────────────────

def _mask(value: str) -> dict:
    return {"set": bool(value), "hint": f"••••{value[-4:]}" if len(value) >= 8 else ("••••" if value else "")}


def provider_configured(prov: dict) -> bool:
    return bool(prov.get("api_key")) if prov.get("type") == "google" else bool(prov.get("base_url"))


def public_provider(pid: str, prov: dict) -> dict:
    return {"id": pid, "name": prov.get("name") or pid, "type": prov.get("type"), "base_url": prov.get("base_url", ""),
            "api_key": _mask(prov.get("api_key", "")), "configured": provider_configured(prov)}


def _model_usage() -> dict[str, dict[str, list[str]]]:
    """OCR ไม่ผูกโมเดลไว้กับข้อมูลใด ๆ — แก้หรือลบโมเดลได้อิสระ"""
    return {}


def public_settings(settings: dict) -> dict:
    usage = _model_usage()
    providers = settings["providers"]
    return {
        "providers": [public_provider(pid, prov) for pid, prov in providers.items()],
        "models": [{"id": mid, **e, "provider_name": (providers.get(e.get("provider")) or {}).get("name", "—"),
                    "is_default": settings["defaults"].get(e["kind"]) == mid,
                    "used_by": usage.get(mid, {"jobs": []})}
                   for mid, e in settings["registry"].items()],
        "defaults": settings["defaults"],
        "vector": {"type": settings["vector"].get("type") or "qdrant", "url": settings["vector"].get("url", ""),
                   "api_key": _mask(settings["vector"].get("api_key", "")),
                   "tunnel": TUNNEL.state if settings["vector"].get("type") == "local" else None},
        "central": {"url": settings["central"].get("url", ""), "license_key": _mask(settings["central"].get("license_key", ""))},
        "notify": {"enabled": bool(settings["notify"].get("enabled")),
                   "recipients": [_recipient_public(r) for r in settings["notify"].get("recipients", [])],
                   "template": settings["notify"].get("template", ""), "api_key": _mask(settings["notify"].get("api_key", ""))},
    }


def _apply_secret(target: dict, key: str, value) -> None:
    """ช่อง key: ไม่ส่ง/ส่งว่าง = ใช้ค่าเดิม, ส่ง null = ลบ"""
    if value is None:
        target[key] = ""
    elif isinstance(value, str) and value.strip():
        target[key] = value.strip()


# ── แปลงเป็น credentials ที่ central รับ ──────────────

def _endpoint(prov: dict) -> tuple[str, str | None, str]:
    """(provider ที่ central รู้จัก, base_url, api_key) — ollama ใช้ endpoint แบบ OpenAI ที่ /v1
    (แปลงที่ node เพื่อให้ใช้ได้แม้ central ยังเป็นรุ่นที่ไม่รู้จัก ollama)"""
    key = prov.get("api_key", "")
    typ = prov.get("type")
    if typ == "google":
        return "google", None, key
    base = (prov.get("base_url") or "").strip().rstrip("/")
    if typ == "ollama":
        base = base or "http://localhost:11434"
        return "openai_compatible", base if base.endswith("/v1") else f"{base}/v1", key or "ollama"
    return "openai_compatible", base or None, key or "not-needed"


def resolve_model(s: dict, kind: str, model_id: str | None = None) -> tuple[str | None, dict | None]:
    """โมเดลที่เลือกไว้ (ถ้ายังมีอยู่และเป็นประเภทถูก) ไม่งั้นค่าเริ่มต้นของประเภทนั้น"""
    for mid in (model_id, s["defaults"].get(kind)):
        e = s["registry"].get(mid or "")
        if e and e["kind"] == kind:
            return mid, e
    return None, None


def model_creds(s: dict, entry: dict | None) -> dict:
    if not entry:
        return {}
    kind, base, key = _endpoint(s["providers"].get(entry.get("provider") or "", {}))
    out = {"provider": kind, "model": entry.get("model", ""), "api_key": key}
    if base:
        out["base_url"] = base
    if entry.get("params"):
        out["params"] = entry["params"]  # พารามิเตอร์เพิ่มเติมของโมเดล — central ส่งต่อให้ผู้ให้บริการตรง ๆ
    return out


def vector_creds(s: dict) -> dict:
    v = s["vector"]
    kind = v.get("type") or "qdrant"
    if kind == "pgvector":
        return {"type": "pgvector", "url": v.get("api_key") or ""}
    if kind == "pinecone":
        return {"type": "pinecone", "api_key": v.get("api_key") or None}
    if kind == "local":
        return {"type": "qdrant", "tunnel": True}  # the Qdrant URL/key stay on this node; central reaches it through the tunnel
    return {"url": v.get("url", ""), "api_key": v.get("api_key") or None}


def credentials(settings: dict | None = None, **_unused) -> dict:
    """OCR ใช้แค่ LLM (อ่านภาพ/PDF) — ไม่มีฐานเวกเตอร์ ไม่มี embedding"""
    s = settings or load_settings()
    creds = {"llm": model_creds(s, resolve_model(s, "llm")[1])}
    _await_tunnel(creds)  # a tunnel that was just opened may not be up yet — wait a moment before calling central
    return creds


# ── รายชื่อโมเดลจากผู้ให้บริการ ─────────────────────────

_NON_TEXT_MODEL = re.compile(r"tts|text-to-speech|cosyvoice|voice|audio-gen|image|imagen|flux|stable-diffusion|sdxl|kolors|"
                             r"dall-e|video|veo|wan2|-vl-?gen|moderation", re.I)


def _guess_kinds(model_id: str) -> list[str]:
    mid = model_id.lower()
    if _NON_TEXT_MODEL.search(mid):
        return []
    if "rerank" in mid:
        return ["rerank"]
    if any(w in mid for w in ("whisper", "sensevoice", "transcribe", "asr", "speech-to-text", "stt")):
        return ["stt"]
    if any(w in mid for w in ("embed", "bge-", "/bge", "e5-", "gte-", "minilm")):
        return ["embedding"]
    return ["llm"]


def list_provider_models(prov: dict) -> list[dict]:
    """ดึงรายชื่อโมเดลจากผู้ให้บริการโดยตรง (ใช้แสดงตัวเลือกในหน้าตั้งค่าเท่านั้น)"""
    try:
        if prov.get("type") == "google":
            if not prov.get("api_key"):
                raise err(400, "api_key_required", "Enter an API key first")
            r = httpx.get("https://generativelanguage.googleapis.com/v1beta/models",
                          params={"key": prov["api_key"], "pageSize": 1000}, timeout=15)
            r.raise_for_status()
            out = []
            for m in r.json().get("models", []):
                methods = m.get("supportedGenerationMethods", [])
                kinds = (["llm"] if "generateContent" in methods else []) + (["embedding"] if "embedContent" in methods else [])
                if "generateContent" in methods and m["name"].startswith("models/gemini"):
                    kinds.append("stt")  # Gemini ถอดเสียงได้ในตัว (multimodal)
                mid = m["name"].removeprefix("models/")
                if kinds and not _NON_TEXT_MODEL.search(mid):
                    out.append({"id": mid, "kinds": kinds})
            return sorted(out, key=lambda x: x["id"])
        _, base, key = _endpoint(prov)
        if not base:
            raise err(400, "server_url_required", "Enter the server URL first")
        headers = {"Authorization": f"Bearer {key}"} if key and key not in ("ollama", "not-needed") else {}
        r = httpx.get(f"{base}/models", headers=headers, timeout=15)
        r.raise_for_status()
        models = ({"id": m["id"], "kinds": _guess_kinds(m["id"])} for m in r.json().get("data", []))
        return sorted((m for m in models if m["kinds"]), key=lambda x: x["id"])
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        if code in (400, 401, 403):  # Gemini API answers 400 when the key is wrong
            raise err(400, "provider_auth_failed", "The API key is invalid or has no permission")
        if code == 404:
            raise err(400, "provider_endpoint_not_found", "Endpoint not found. Check the URL (usually ends with /v1)")
        raise err(400, "provider_error", f"The provider returned {code}", status=code)
    except httpx.HTTPError as e:
        raise err(400, "provider_unreachable", f"Cannot reach the provider ({type(e).__name__})", error=type(e).__name__)


# ══════════════════════════════════════════════
# Central client
# ══════════════════════════════════════════════

_tokens: dict[tuple, dict] = {}
_token_lock = threading.Lock()


class CentralError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@app.exception_handler(CentralError)
async def _central_error_handler(_req: Request, e: CentralError):
    return JSONResponse({"detail": {"code": e.code, "message": e.message, "params": {}}},
                        status_code=e.status if e.status < 500 else 502)


_LICENSE_STATE_KEY = "license_state"
DISPLACED_MESSAGE = "This license was activated on another machine. Use it on this machine again from Settings."

def license_displaced() -> bool:
    with _db() as c:
        row = c.execute("SELECT value FROM settings WHERE key=?", (_LICENSE_STATE_KEY,)).fetchone()
    return bool(row and json.loads(row[0]).get("displaced"))


def _set_license_displaced(value: bool) -> None:
    with _db_lock, _db() as c:
        c.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (_LICENSE_STATE_KEY, json.dumps({"displaced": value, "at": _now()})))


def _should_reauth(resp: httpx.Response) -> bool:
    """401 จาก central: ขอ token ใหม่แล้วลองอีกครั้งได้เฉพาะ token หมดอายุ/เสีย — ถ้าถูกเครื่องอื่นแทนที่
    ห้ามขอใหม่เอง (การขอ token คือการผูก license กลับมาที่เครื่องนี้ = แย่งกันไปมา) ต้องให้ admin กดยืนยัน
    (ต้องอ่าน body ของ response แล้วก่อนเรียก)"""
    if resp.status_code != 401:
        return False
    try:
        code = (resp.json().get("error") or {}).get("code")
    except Exception:
        code = None
    if code == "device_replaced":
        _set_license_displaced(True)
        with _token_lock:
            _tokens.clear()
        return False
    return code in (None, "token_expired", "auth_invalid")


def _raise_for(resp: httpx.Response):
    if resp.status_code < 400:
        return
    try:
        err = resp.json().get("error") or {}
    except Exception:
        err = {}
    raise CentralError(resp.status_code, err.get("code") or "central_error", err.get("message") or f"Central returned {resp.status_code}")


# ── ช่องทางไป central ต้องปลอดภัย ─────────────────────
# ทุก request แนบ key ของ AI + เอกสาร/ข้อมูลลูกค้าไปด้วย จึงห้ามวิ่งผ่าน http บนอินเทอร์เน็ตเด็ดขาด
# http ยอมเฉพาะปลายทางที่ไม่ออกอินเทอร์เน็ต: เครื่องเดียวกัน, ชื่อ service ใน docker, IP วง LAN (ไว้ dev/ทดสอบ)
# CENTRAL_CA_FILE (ไม่บังคับ) = ไฟล์ใบรับรอง/CA ที่ยอมรับได้ "อย่างเดียว" สำหรับ central (pin) แทนการเชื่อ CA ทั้งโลก
_ca_file = os.environ.get("CENTRAL_CA_FILE", "").strip()
CENTRAL_VERIFY: ssl.SSLContext | bool = ssl.create_default_context(cafile=_ca_file) if _ca_file else True


def _insecure_central_reason(url: str) -> str | None:
    if not url:
        return None
    u = urlparse(url)
    if u.scheme == "https":
        return None
    if u.scheme != "http":
        return "The central address must start with https://"
    host = (u.hostname or "").lower()
    if host == "localhost" or (host and "." not in host):  # localhost หรือชื่อ service ใน docker network
        return None
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:  # loopback, LAN, CGNAT (เช่น Tailscale)
            return None
    except ValueError:
        pass
    return "Central must use https:// (http is only allowed on the same machine or LAN)"

def _central(settings: dict | None = None, check: bool = True) -> tuple[str, str]:
    c = (settings or load_settings())["central"]
    url = (c.get("url") or "").rstrip("/")
    if check and (reason := _insecure_central_reason(url)):
        raise CentralError(400, "central_insecure", reason)
    return url, c.get("license_key") or ""


def get_token(force: bool = False, settings: dict | None = None) -> str:
    url, lic = _central(settings)
    cache_key = (url, lic)
    with _token_lock:
        cached = _tokens.get(cache_key)
        if not force and cached and cached["exp"] - 60 > time.time():
            return cached["value"]
        _tokens.pop(cache_key, None)
        if not url:
            raise CentralError(500, "no_central", "The central address is not set (Settings)")
        if not lic:
            raise CentralError(500, "no_license", "No license key yet (Settings)")
        if license_displaced():
            raise CentralError(401, "device_replaced", DISPLACED_MESSAGE)
        try:
            resp = httpx.post(f"{url}/v1/auth/token", json={"license_key": lic, "install_id": install_id()}, timeout=20, verify=CENTRAL_VERIFY)
        except httpx.HTTPError as e:
            raise CentralError(502, "central_unreachable", f"Cannot reach central at {url} ({type(e).__name__})")
        _raise_for(resp)
        body = resp.json()
        _tokens[cache_key] = {"value": body["access_token"], "exp": time.time() + int(body.get("expires_in", 900)),
                              "license": body.get("license"), "warnings": body.get("warnings") or []}
        return body["access_token"]


def token_info(settings: dict | None = None) -> dict:
    return _tokens.get(_central(settings)) or {}


def live_license(settings: dict | None = None) -> dict:
    """สถานะ license ตอนนี้จาก central — ค่าใน token_info คือค่าตอนขอ token (จำไว้ได้ถึง 15 นาที) จึงไม่ทันการ
    ระงับ/ต่ออายุ ถ้าถูกระงับ central ตอบรหัสนั้นกลับมาเป็น CentralError
    central รุ่นเก่าที่ยังไม่มี /v1/license → ใช้ค่าที่จำไว้แทน"""
    url, _ = _central(settings)
    resp = None
    for attempt in range(2):
        token = get_token(force=attempt > 0, settings=settings)
        try:
            resp = httpx.get(f"{url}/v1/license", headers={"Authorization": f"Bearer {token}"}, timeout=10, verify=CENTRAL_VERIFY)
        except httpx.HTTPError as e:
            raise CentralError(502, "central_unreachable", f"Cannot reach central ({type(e).__name__})")
        if resp.status_code == 404:
            info = token_info(settings)
            return {"license": info.get("license"), "warnings": info.get("warnings")}
        if attempt == 0 and _should_reauth(resp):
            continue
        break
    _raise_for(resp)
    return resp.json()


def central_json(path: str, body: dict, settings: dict | None = None) -> dict:
    url, _ = _central(settings)
    resp = None
    for attempt in range(2):
        token = get_token(force=attempt > 0, settings=settings)
        try:
            resp = httpx.post(f"{url}{path}", json=body, headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT,
                              verify=CENTRAL_VERIFY)
        except httpx.HTTPError as e:
            raise CentralError(502, "central_unreachable", f"Cannot reach central ({type(e).__name__})")
        if attempt == 0 and _should_reauth(resp):
            continue
        break
    _raise_for(resp)
    return resp.json()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_filename(name: str) -> str:
    name = Path(name or "").name
    if not name or name in {".", ".."}:
        raise err(400, "invalid_filename", "Invalid file name")
    return name


# ── tunnel: central reaches a vector database on this machine/LAN through a connection this node opens itself ──
TUNNEL = TunnelClient(
    central_url=lambda: _central(check=False)[0],
    token=lambda force: get_token(force=force),
    target=lambda: (load_settings()["vector"].get("url", ""), load_settings()["vector"].get("api_key") or None),
    verify=CENTRAL_VERIFY,
)


def _needs_tunnel(s: dict) -> bool:
    return (s["vector"].get("type") or "qdrant") == "local"


def sync_tunnel() -> None:
    if _needs_tunnel(load_settings()):
        TUNNEL.start()
    else:
        TUNNEL.stop()


def _await_tunnel(creds: dict, seconds: float = 10) -> None:
    if not any(isinstance(v, dict) and v.get("tunnel") for v in creds.values()):
        return
    TUNNEL.start()
    end = time.time() + seconds
    while TUNNEL.state["status"] != "connected" and time.time() < end:
        time.sleep(0.3)


@app.on_event("startup")
def _startup():
    init_db()
    load_settings()
    sync_tunnel()


# ══════════════════════════════════════════════
# หลังบ้าน: การเชื่อมต่อ (Settings) + สถานะ
# ══════════════════════════════════════════════

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/admin/settings")
def get_settings():
    return {"settings": public_settings(load_settings()), "protocols": PROTOCOLS}


@app.put("/api/admin/settings")
def save_settings(body: dict = Body(...)):
    """บันทึกโครงสร้างพื้นฐาน (vector database, central/license) — การเชื่อมต่อและคลังโมเดลมี endpoint ของตัวเอง"""
    s = load_settings()
    incoming = body.get("settings") or {}
    new = json.loads(json.dumps(s))
    for section, secret in (("vector", "api_key"), ("central", "license_key")):
        for k, v in (incoming.get(section) or {}).items():
            if k == secret:
                _apply_secret(new[section], k, v)
            elif k == "url":
                new[section]["url"] = (v or "").strip()
            elif k == "type" and section == "vector":
                if v not in VECTOR_TYPES:
                    raise err(400, "invalid_vector_type", "Unsupported vector database type", allowed=", ".join(VECTOR_TYPES))
                new["vector"]["type"] = v
                if v not in ("qdrant", "local"):
                    new["vector"]["url"] = ""  # URL ใช้กับ Qdrant เท่านั้น — ไม่ให้ค่าเก่าค้างไปปนกับชนิดอื่น
    for k, v in (incoming.get("notify") or {}).items():
        if k == "api_key":
            _apply_secret(new["notify"], k, v)
        elif k == "enabled":
            new["notify"]["enabled"] = bool(v)
        elif k == "template":
            new["notify"]["template"] = str(v or "").strip()[:500]
    if (reason := _insecure_central_reason(new["central"].get("url", "").rstrip("/"))):
        raise err(400, "central_insecure", reason)
    _write_settings(new)
    with _token_lock:
        _tokens.clear()
    if "license_key" in (incoming.get("central") or {}):
        _set_license_displaced(False)
    if new["central"] != s["central"]:
        TUNNEL.reconnect()  # the open tunnel is still tied to the old central/license
    sync_tunnel()
    return {"settings": public_settings(load_settings())}


# ── การเชื่อมต่อ ─────────────────────────────────────

class ProviderIn(BaseModel):
    name: str
    base_url: str = ""
    api_key: str | None = ""  # "" = ใช้ค่าเดิม (ตอนแก้ไข), null = ลบ


def detect_type(base_url: str, existing_type: str | None = None) -> str:
    """เดารูปแบบ API จาก URL ให้ผู้ใช้กรอกแค่ URL/key เหมือนใส่ใน .env"""
    url = (base_url or "").strip().lower()
    if not url:
        return existing_type or "google"
    if "generativelanguage.googleapis.com" in url and "/openai" not in url:
        return "google"
    if ":11434" in url or "ollama" in url:
        return "ollama"
    return "openai_compatible"


def _provider_from_input(req: ProviderIn, existing: dict | None = None) -> dict:
    if not req.name.strip():
        raise err(400, "connection_name_required", "Enter a connection name")
    prov = {"name": req.name.strip(), "type": detect_type(req.base_url, (existing or {}).get("type")),
            "base_url": req.base_url.strip(), "api_key": (existing or {}).get("api_key", "")}
    _apply_secret(prov, "api_key", req.api_key)
    if prov["type"] == "google" and not prov["api_key"]:
        raise err(400, "gemini_key_required", "Google Gemini needs an API key")
    return prov


def _update_settings(**sections) -> None:
    _write_settings({**load_settings(), **sections})


@app.post("/api/admin/providers")
def create_provider(req: ProviderIn):
    s = load_settings()
    pid = "p_" + _new_id()[:8]
    _update_settings(providers={**s["providers"], pid: _provider_from_input(req)})
    return public_provider(pid, load_settings()["providers"][pid])


@app.put("/api/admin/providers/{pid}")
def update_provider(pid: str, req: ProviderIn):
    s = load_settings()
    if pid not in s["providers"]:
        raise err(404, "connection_not_found", "Connection not found")
    _update_settings(providers={**s["providers"], pid: _provider_from_input(req, s["providers"][pid])})
    return public_provider(pid, load_settings()["providers"][pid])


@app.delete("/api/admin/providers/{pid}")
def delete_provider(pid: str):
    s = load_settings()
    if pid not in s["providers"]:
        raise err(404, "connection_not_found", "Connection not found")
    used = [e["name"] for e in s["registry"].values() if e.get("provider") == pid]
    if used:
        raise err(409, "connection_in_use", "Models still use this connection", items=", ".join(used))
    _update_settings(providers={k: v for k, v in s["providers"].items() if k != pid})
    return {"ok": True}


@app.post("/api/admin/providers/test")
def test_provider(body: dict = Body(...)):
    """ทดสอบการเชื่อมต่อที่ยังไม่บันทึก (หรือที่แก้อยู่) โดยดึงรายชื่อโมเดล — ช่อง key ว่าง = ใช้ key เดิมของ id นั้น"""
    existing = load_settings()["providers"].get(body.get("id") or "", {})
    base = (body.get("base_url") or "").strip()
    prov = {"type": detect_type(base, existing.get("type")), "base_url": base, "api_key": existing.get("api_key", "")}
    _apply_secret(prov, "api_key", body.get("api_key", ""))
    if prov["type"] == "google" and not prov["api_key"]:
        raise err(400, "api_key_required", "Enter an API key first")
    return {"models": list_provider_models(prov), "type": prov["type"]}


@app.post("/api/admin/providers/{pid}/models")
def provider_models(pid: str):
    prov = load_settings()["providers"].get(pid)
    if not prov:
        raise err(404, "connection_not_found", "Connection not found")
    return {"models": list_provider_models(prov)}


# ── คลังโมเดล ────────────────────────────────────────

class ModelIn(BaseModel):
    name: str = ""
    kind: str
    provider: str
    model: str
    dim: int = 0
    make_default: bool = False
    params: dict | str | None = None  # JSON object หรือข้อความ JSON — ส่งต่อให้ผู้ให้บริการตรง ๆ


PARAMS_MAX_CHARS = 8000


def _parse_params(raw) -> dict:
    """พารามิเตอร์เพิ่มเติมของโมเดล: รับได้ทั้ง object และข้อความ JSON (ช่องกรอกในหน้าเว็บ) — ว่าง = {}"""
    if raw is None or raw == "" or raw == {}:
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as e:
            raise err(400, "params_invalid_json", f"Extra parameters must be JSON ({e.msg}, line {e.lineno})", detail=e.msg, line=e.lineno)
    if not isinstance(raw, dict):
        raise err(400, "params_not_object", 'Extra parameters must be a JSON object, e.g. {"temperature": 0.2}')
    if len(json.dumps(raw, ensure_ascii=False)) > PARAMS_MAX_CHARS:
        raise err(400, "params_too_long", "Extra parameters are too long")
    return raw


def _model_from_input(req: ModelIn, s: dict) -> dict:
    if req.kind not in KINDS:
        raise err(400, "invalid_model_kind", "Invalid model type")
    if req.provider not in s["providers"]:
        raise err(400, "connection_required", "Choose a connection first")
    if not req.model.strip():
        raise err(400, "model_name_required", "Enter the model name")
    if req.kind == "rerank" and s["providers"][req.provider].get("type") == "google":
        raise err(400, "rerank_needs_openai_compatible", "Rerank needs an OpenAI-compatible connection with a /rerank endpoint")
    entry = {"name": req.name.strip() or req.model.strip(), "kind": req.kind, "provider": req.provider, "model": req.model.strip()}
    params = _parse_params(req.params)
    if params:
        entry["params"] = params
    if req.kind == "embedding":
        if req.dim <= 0:
            raise err(400, "embedding_dim_required", "Embedding needs its dimension. Press Test to fill it in")
        entry["dim"] = int(req.dim)
    return entry


@app.post("/api/admin/models")
def create_model(req: ModelIn):
    s = load_settings()
    entry = _model_from_input(req, s)
    mid = f"m_{_new_id()[:8]}"
    defaults = dict(s["defaults"])
    if req.make_default or not defaults.get(req.kind):
        defaults[req.kind] = mid
    _update_settings(registry={**s["registry"], mid: entry}, defaults=defaults)
    return {"id": mid}


@app.put("/api/admin/models/{mid}")
def update_model(mid: str, req: ModelIn):
    s = load_settings()
    old = s["registry"].get(mid)
    if not old:
        raise err(404, "model_not_found", "Model not found")
    entry = _model_from_input(ModelIn(**{**req.model_dump(), "kind": old["kind"]}), s)
    defaults = dict(s["defaults"])
    if req.make_default:
        defaults[old["kind"]] = mid
    _update_settings(registry={**s["registry"], mid: entry}, defaults=defaults)
    return {"id": mid}


@app.delete("/api/admin/models/{mid}")
def delete_model(mid: str):
    s = load_settings()
    entry = s["registry"].get(mid)
    if not entry:
        raise err(404, "model_not_found", "Model not found")
    registry = {k: v for k, v in s["registry"].items() if k != mid}
    defaults = dict(s["defaults"])
    if defaults.get(entry["kind"]) == mid:  # ลบตัวที่เป็นค่าเริ่มต้น → ยกตัวอื่นประเภทเดียวกันขึ้นแทน (ถ้ามี)
        defaults[entry["kind"]] = next((k for k, v in registry.items() if v["kind"] == entry["kind"]), None)
    _update_settings(registry=registry, defaults=defaults)
    return {"ok": True}


@app.post("/api/admin/models/{mid}/default")
def set_default_model(mid: str):
    s = load_settings()
    entry = s["registry"].get(mid)
    if not entry:
        raise err(404, "model_not_found", "Model not found")
    _update_settings(defaults={**s["defaults"], entry["kind"]: mid})
    return {"ok": True}


@app.post("/api/admin/models/test")
def test_model(body: dict = Body(...)):
    """ทดสอบโมเดลก่อนบันทึก ผ่าน central (เส้นทางเดียวกับใช้งานจริง) — embedding จะได้จำนวนมิติกลับมาด้วย"""
    s = load_settings()
    kind = body.get("kind")
    prov = s["providers"].get(body.get("provider") or "")
    if kind not in KINDS or not prov:
        raise err(400, "kind_connection_required", "Choose a type and connection first")
    cfg = model_creds(s, {"provider": body.get("provider"), "model": (body.get("model") or "").strip(),
                          "params": _parse_params(body.get("params"))})
    creds = credentials(s, use_rerank=False)
    if kind == "rerank":
        creds["rerank"] = {"api_key": cfg["api_key"], "model": cfg["model"], "base_url": cfg.get("base_url"), "params": cfg.get("params") or {}}
    else:
        creds[kind] = cfg
    result = central_json("/v1/credentials/check", {"ctx": {"credentials": creds}})
    return result.get(kind) or {"ok": False, "error_code": "no_result", "message": "No result"}


# ── ตรวจ / สถานะ ─────────────────────────────────────

def _run_check(settings: dict) -> dict:
    """ตรวจทุกส่วนด้วยค่าเริ่มต้นของแต่ละประเภท"""
    url, _ = _central(settings, check=False)
    out: dict = {"central": {"url": url}}
    try:
        if (reason := _insecure_central_reason(url)):
            raise ValueError(reason)
        meta = httpx.get(f"{url}/v1/meta", timeout=10, verify=CENTRAL_VERIFY).json()
        out["central"].update({"ok": True, "api_version": meta.get("api_version")})
    except Exception as e:
        out["central"].update({"ok": False, "message": str(e) if isinstance(e, ValueError) else f"Cannot reach central ({type(e).__name__})"})
        return out
    try:
        info = live_license(settings)
        out["license"] = {"ok": True, **(info.get("license") or {}), "warnings": info.get("warnings")}
    except CentralError as e:
        out["license"] = {"ok": False, "code": e.code, "message": e.message}
        return out
    try:
        creds = credentials(settings)
        check = central_json("/v1/credentials/check", {"ctx": {"credentials": creds}}, settings=settings)
        out["llm"] = check.get("llm")
    except CentralError as e:
        out["llm"] = {"ok": False, "error_code": e.code, "message": e.message}
    return out


@app.post("/api/admin/check")
def check_saved():
    return _run_check(load_settings())


@app.get("/api/health")
def health():
    return _run_check(load_settings())


@app.get("/api/admin/status")
def admin_status():
    s = load_settings()
    url, _ = _central(s, check=False)
    central: dict = {"url": url}
    try:
        if (reason := _insecure_central_reason(url)):
            raise ValueError(reason)
        meta = httpx.get(f"{url}/v1/meta", timeout=8, verify=CENTRAL_VERIFY).json()
        central.update({"ok": True, "api_version": meta.get("api_version")})
    except Exception as e:
        central.update({"ok": False, "message": str(e) if isinstance(e, ValueError) else f"Cannot reach central ({type(e).__name__})"})
    license_info: dict = {"displaced": license_displaced()}
    if central["ok"]:
        try:
            info = live_license(s)
            license_info = {"ok": True, **(info.get("license") or {}), "warnings": info.get("warnings"), "displaced": False}
        except CentralError as e:
            license_info = {"ok": False, "code": e.code, "message": e.message, "displaced": e.code == "device_replaced"}

    def default_of(kind: str) -> dict | None:
        mid, e = resolve_model(s, kind)
        if not e:
            return None
        return {"id": mid, "name": e["name"], "model": e["model"], "dim": e.get("dim"),
                "provider_name": (s["providers"].get(e.get("provider")) or {}).get("name", "—")}

    return {
        "central": central,
        "license": license_info,
        "defaults": {k: default_of(k) for k in KINDS},
        "model_counts": {k: sum(1 for e in s["registry"].values() if e["kind"] == k) for k in KINDS},
        "counts": {"docs": len(db_all("docs")), "rules": len(db_all("rules"))},
        "usage": get_usage(),
    }


@app.post("/api/admin/license/claim")
def claim_license():
    """ย้าย license กลับมาใช้ที่เครื่องนี้ (admin กดเอง) — เครื่องอื่นที่ใช้อยู่จะถูกตัดแทน
    central จำกัดจำนวนครั้งที่สลับเครื่องต่อชั่วโมง กันสองเครื่องผลัดกันใช้ key เดียว"""
    _set_license_displaced(False)
    get_token(force=True)
    info = token_info()
    return {"ok": True, "license": info.get("license"), "warnings": info.get("warnings")}


# ══════════════════════════════════════════════
# หน้าตั้งค่าครั้งแรก — license → AI (URL + key + โมเดล) → ฐานข้อมูลเวกเตอร์ ตั้งเองในเบราว์เซอร์ได้ครบ ไม่ต้องแก้ .env
# ══════════════════════════════════════════════

def _vector_ready(v: dict) -> bool:
    return bool(v.get("api_key")) if (v.get("type") or "qdrant") in ("pgvector", "pinecone") else bool(v.get("url"))


def setup_status(s: dict | None = None) -> dict:
    s = s or load_settings()
    has_license = bool(s["central"].get("license_key"))
    _, llm = resolve_model(s, "llm")

    def keyed(entry):
        prov = (s["providers"].get((entry or {}).get("provider") or "") or {})
        return bool(entry) and (bool(prov.get("api_key")) or prov.get("type") == "ollama")

    needs = not (has_license and keyed(llm))
    return {"needs_setup": (not _credentials_set()) or (needs and not (s.get("setup") or {}).get("completed")),
            "has_license": has_license, "has_llm": keyed(llm),
            "has_password": _credentials_set(), "password_from_env": bool(NODE_PASSWORD), "admin_user": NODE_USER, "central_url": s["central"].get("url", "")}


_program_cache: dict = {"at": 0.0, "value": None}


def central_program(s: dict | None = None) -> dict | None:
    """central แจกอะไรอยู่ตอนนี้ (Free Beta หรือทดลอง) — จำไว้ 60 วินาที · ติดต่อไม่ได้ = None"""
    if time.time() - _program_cache["at"] < 60:
        return _program_cache["value"]
    url = (s or load_settings())["central"].get("url", "")
    value = None
    if url:
        try:
            resp = httpx.get(f"{url}/v1/program", timeout=5, verify=CENTRAL_VERIFY)
            value = resp.json() if resp.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            value = None
    _program_cache.update(at=time.time(), value=value)
    return value


@app.get("/api/admin/setup")
def get_setup():
    return {**setup_status(), "program": central_program()}


def _save_license(key: str) -> None:
    s = load_settings()
    _update_settings(central={**s["central"], "license_key": key.strip()})
    with _token_lock:
        _tokens.clear()
    _set_license_displaced(False)


@app.post("/api/admin/setup/demo")
def setup_demo(body: dict = Body(...)):
    """ขอ license ฟรีจาก central (ผูกกับเครื่องนี้) แล้วบันทึก key ให้เลย"""
    url, _ = _central(check=False)
    try:
        resp = httpx.post(f"{url}/v1/demo/start", json={"email": str(body.get("email") or ""), "install_id": install_id()},
                          timeout=20, verify=CENTRAL_VERIFY)
    except httpx.HTTPError as e:
        raise CentralError(502, "central_unreachable", f"Cannot reach central ({type(e).__name__})")
    _raise_for(resp)
    _save_license(resp.json()["license_key"])
    get_token(force=True)
    return {**setup_status(), "license_type": resp.json().get("license_type")}


@app.post("/api/admin/setup/license")
def setup_license(body: dict = Body(...)):
    key = str(body.get("license_key") or "").strip()
    if not key:
        raise err(400, "setup_license_required", "Enter the license key")
    old = load_settings()["central"].get("license_key", "")
    _save_license(key)
    try:
        get_token(force=True)
    except CentralError:
        _save_license(old)  # the key doesn't work — put the old one back
        raise
    return setup_status()


def _upsert_provider(s: dict, name: str, typ: str, base_url: str, api_key: str) -> str:
    for pid, p in s["providers"].items():
        if p.get("type") == typ and (p.get("base_url") or "").rstrip("/") == base_url.rstrip("/"):
            s["providers"][pid] = {**p, "api_key": api_key}
            return pid
    pid = "p_" + _new_id()[:8]
    s["providers"][pid] = {"name": name, "type": typ, "base_url": base_url, "api_key": api_key}
    return pid


def _upsert_model(s: dict, kind: str, provider: str, model: str, dim: int | None = None) -> str:
    for mid, e in s["registry"].items():
        if e["kind"] == kind and e.get("provider") == provider and e["model"] == model and (kind != "embedding" or e.get("dim") == dim):
            break
    else:
        mid = f"m_{_new_id()[:8]}"
        s["registry"][mid] = {"name": model, "kind": kind, "provider": provider, "model": model, **({"dim": dim} if dim else {})}
    s["defaults"][kind] = mid
    return mid


def _setup_endpoint(item: dict | None) -> tuple[str, str, str, str] | None:
    """URL + key + ชื่อโมเดล จากหน้าตั้งค่า → (type, url, key, model) · None ถ้าไม่ได้กรอกเลย (เช่น rerank ที่ไม่บังคับ)"""
    item = item or {}
    url, key, model = (str(item.get(k) or "").strip() for k in ("base_url", "api_key", "model"))
    if not (url or key or model):
        return None
    typ = detect_type(url)  # empty URL = a provider that needs only a key
    if not model or (typ != "ollama" and not key):
        raise err(400, "setup_ai_incomplete", "Enter the API key and choose a model")
    return typ, url, key, model


@app.post("/api/admin/setup/discover")
def setup_discover(body: dict = Body(...)):
    """ดึงรายชื่อโมเดลจาก URL + key ที่กรอก (ยังไม่บันทึก) ให้เลือกแทนการพิมพ์ชื่อเอง"""
    url, key = str(body.get("base_url") or "").strip(), str(body.get("api_key") or "").strip()
    typ = detect_type(url)
    if typ != "ollama" and not key:
        raise err(400, "setup_discover_no_key", "Enter the API key first")
    return {"type": typ, "models": list_provider_models({"type": typ, "base_url": url, "api_key": key})}


@app.post("/api/admin/setup/ai")
def setup_ai(body: dict = Body(...)):
    """ตั้ง LLM (อ่านภาพ/PDF) จาก URL/key/ชื่อโมเดลที่ผู้ใช้ใส่ — ตรวจผ่าน central ก่อนบันทึก
    (ถ้าตรวจไม่ผ่านจะไม่บันทึกอะไรเลย) งาน OCR ไม่ต้องมี embedding หรือฐานเวกเตอร์"""
    llm = _setup_endpoint(body.get("llm"))
    if llm is None:
        raise err(400, "setup_ai_incomplete", "Enter the API key and choose a model")
    s = json.loads(json.dumps(load_settings()))
    typ, url, key, model = llm
    p_llm = _upsert_provider(s, urlparse(url).hostname or url or typ, typ, url, key)
    creds = {"llm": model_creds(s, {"provider": p_llm, "model": model})}
    check = central_json("/v1/credentials/check", {"ctx": {"credentials": creds}})
    item = check.get("llm") or {}
    if not item.get("ok"):
        raise CentralError(422, item.get("error_code") or "credential_invalid", f"llm: {item.get('message') or 'check failed'}")
    _upsert_model(s, "llm", p_llm, model)
    _write_settings(s)
    return setup_status()


@app.post("/api/admin/setup/password")
def setup_password(request: Request, body: dict = Body(...)):
    """ตั้งรหัสผ่านหลังบ้านจากหน้าตั้งค่าครั้งแรก (เก็บแบบ hash) แล้วเข้าสู่ระบบให้เลย"""
    if NODE_PASSWORD:
        raise err(409, "password_from_env", "The password is set in this machine's config file (NODE_PASSWORD)")
    pw = str(body.get("password") or "")
    if len(pw) < 8:
        raise err(400, "password_too_short", "Use at least 8 characters", min=8)
    s = load_settings()
    _update_settings(setup={**(s.get("setup") or {}), "password_hash": _hash_password(pw)})
    resp = JSONResponse({**setup_status(), "admin_user": NODE_USER})
    _set_session_cookie(resp, request)
    return resp


@app.post("/api/admin/setup/finish")
def setup_finish():
    s = load_settings()
    _update_settings(setup={**(s.get("setup") or {}), "completed": True})
    return setup_status()


# ── แพ็กเกจ / ชำระเงิน (Stripe อยู่ที่ central) ─────────
# ยืนยันตัวด้วย license key ตรง ๆ ไม่ใช่ token — ตอน demo/license หมดอายุ token ขอไม่ได้ ซึ่งเป็นจังหวะที่ต้องจ่ายพอดี

def _billing_call(method: str, path: str, body: dict | None = None) -> dict:
    s = load_settings()
    url, lic = _central(s)
    try:
        resp = httpx.request(method, f"{url}{path}", json=body, headers={"X-License-Key": lic}, timeout=30, verify=CENTRAL_VERIFY)
    except httpx.HTTPError as e:
        raise CentralError(502, "central_unreachable", f"Cannot reach central ({type(e).__name__})")
    if resp.status_code == 404:
        raise CentralError(404, "billing_unavailable", "Payments are not enabled on this central. Contact your provider")
    _raise_for(resp)
    return resp.json()


@app.get("/api/admin/billing")
def billing_status():
    try:
        return _billing_call("GET", "/v1/billing/status")
    except CentralError as e:
        return {"enabled": False, "message": e.message}


@app.post("/api/admin/billing/checkout")
def billing_checkout(body: dict = Body(default={})):
    """คืน URL หน้าชำระเงินของ Stripe — จ่ายเสร็จ Stripe พากลับมาที่ return_url (หน้าหลังบ้านของเครื่องนี้)"""
    interval = body.get("interval") if body.get("interval") in ("month", "year") else "month"
    return _billing_call("POST", "/v1/billing/checkout", {"interval": interval, "return_url": body.get("return_url") or ""})


@app.post("/api/admin/billing/portal")
def billing_portal(body: dict = Body(default={})):
    """หน้าจัดการการชำระเงินของ Stripe (เปลี่ยนบัตร / ยกเลิก / ดูใบเสร็จ)"""
    return _billing_call("POST", "/v1/billing/portal", {"return_url": body.get("return_url") or ""})


@app.get("/api/usage")
def usage():
    return get_usage()


# ══════════════════════════════════════════════
# OCR: อ่านเอกสาร (central) → ตรวจตามกฎ (โค้ด ไม่ใช้ AI) → เก็บรายการที่ผ่าน/รอตรวจใน node.db → แจ้งเตือน LINE
# ไม่เก็บไฟล์ต้นฉบับ — เก็บเฉพาะข้อความที่อ่านได้กับฟิลด์ (ลบรายการได้ทุกเมื่อ)
# ══════════════════════════════════════════════

OCR_SUFFIX_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
                   ".pdf": "application/pdf"}
MAX_OCR_MB = int(os.environ.get("MAX_OCR_MB", "20"))
LINE_API = os.environ.get("LINE_API_BASE", "https://api.line.me").rstrip("/")
DEFAULT_RULE_ID = "default"
DOC_STATUSES = ("pending_review", "approved", "failed")
_ocr_slots = threading.Semaphore(int(os.environ.get("OCR_CONCURRENCY", "3")))


class RuleIn(BaseModel):
    name: str = Field(default="", max_length=120)
    required_labels: list[str] = Field(default_factory=list)
    min_confidence: float = 0.6
    auto_approve: bool = False


class DocEditIn(BaseModel):
    fields: list[dict]
    approve: bool = False


def _clean_labels(labels: list[str]) -> list[str]:
    seen, out = set(), []
    for raw in labels:
        label = re.sub(r"\s+", " ", str(raw or "")).strip()[:120]
        if label and label.casefold() not in seen:
            seen.add(label.casefold())
            out.append(label)
    return out[:60]


def _rule_from_input(req: RuleIn, rule_id: str, existing: dict | None = None) -> dict:
    conf = max(0.0, min(1.0, float(req.min_confidence)))
    return {"id": rule_id, "name": req.name.strip() or (existing or {}).get("name") or rule_id,
            "required_labels": _clean_labels(req.required_labels), "min_confidence": conf,
            "auto_approve": bool(req.auto_approve), "created_at": (existing or {}).get("created_at") or _now(),
            "updated_at": _now()}


def _ensure_default_rule() -> None:
    if not db_get("rules", DEFAULT_RULE_ID):
        db_put("rules", DEFAULT_RULE_ID, {"id": DEFAULT_RULE_ID, "name": "", "required_labels": [], "min_confidence": 0.6,
                                          "auto_approve": False, "created_at": _now(), "updated_at": _now()})


def _rule(rule_id: str) -> dict:
    _ensure_default_rule()
    rule = db_get("rules", rule_id or DEFAULT_RULE_ID)
    if not rule:
        raise err(404, "rule_not_found", "Rule set not found")
    return rule


_LABEL_NOISE = re.compile(r"[\s:：;,.\-_/\\()\[\]{}|*#]+")


def _norm_label(text: str) -> str:
    return _LABEL_NOISE.sub(" ", str(text or "").casefold()).strip()


def _label_matches(wanted: str, found: str) -> bool:
    a, b = _norm_label(wanted), _norm_label(found)
    if not a or not b:
        return False
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return len(shorter) >= 3 and shorter in longer


def run_checks(doc: dict, rule: dict) -> dict:
    """ตรวจด้วยโค้ดล้วน ๆ: ฟิลด์ที่ต้องมีครบไหม และฟิลด์ที่อ่านได้มั่นใจพอไหม — ผลเป็นรหัส ให้หน้าเว็บแปลเอง"""
    issues: list[dict] = []
    if doc.get("parse_error"):
        return {"ok": False, "issues": [{"code": "unreadable"}]}
    fields = [f for f in doc.get("fields") or [] if isinstance(f, dict)]
    minimum = float(rule.get("min_confidence") or 0)
    required = rule.get("required_labels") or []
    if required:
        for wanted in required:
            hits = [f for f in fields if _label_matches(wanted, f.get("label", "")) and str(f.get("value", "")).strip()]
            if not hits:
                issues.append({"code": "missing_field", "label": wanted})
            elif max(float(f.get("confidence") or 0) for f in hits) < minimum:
                issues.append({"code": "low_confidence", "label": wanted,
                               "confidence": round(max(float(f.get("confidence") or 0) for f in hits), 2)})
    else:
        for f in fields:
            if str(f.get("value", "")).strip() and float(f.get("confidence") or 0) < minimum:
                issues.append({"code": "low_confidence", "label": str(f.get("label", "")),
                               "confidence": round(float(f.get("confidence") or 0), 2)})
    return {"ok": not issues, "issues": issues}


def _doc_public(doc: dict, detail: bool = False) -> dict:
    out = {k: v for k, v in doc.items() if detail or k != "raw_text"}
    return out


def _doc(doc_id: str) -> dict:
    doc = db_get("docs", doc_id)
    if not doc:
        raise err(404, "doc_not_found", "Document not found")
    return doc


def _central_ocr(filename: str, data: bytes, mime: str, creds: dict) -> dict:
    url, _ = _central()
    payload = {"ctx": {"credentials": creds}}
    for attempt in range(2):
        headers = {"Authorization": f"Bearer {get_token(force=attempt > 0)}"}
        try:
            resp = httpx.post(f"{url}/v1/ocr", headers=headers, timeout=TIMEOUT, verify=CENTRAL_VERIFY,
                              data={"payload": json.dumps(payload, ensure_ascii=False)},
                              files={"file": (filename, data, mime)})
        except httpx.HTTPError as e:
            raise CentralError(502, "central_unreachable", f"Cannot reach central ({type(e).__name__})")
        if resp.status_code == 401 and attempt == 0 and _should_reauth(resp):
            continue
        if resp.status_code >= 400:
            _raise_for(resp)
        return resp.json()
    raise CentralError(502, "ocr_failed", "Central did not return a result")


# ── แจ้งเตือน LINE (push หาเจ้าของ/กลุ่ม — ข้อความมีแค่ชื่อไฟล์กับชื่อหัวข้อที่มีปัญหา ไม่มีเนื้อหาในเอกสาร) ──

NOTIFY_MAX_RECIPIENTS = 10
_LINE_ID_RE = re.compile(r"^[UCR][0-9a-f]{32}$")


def _recipient_public(r: dict) -> dict:
    """ส่งให้หน้าเว็บแค่ชื่อเรียกกับ ID แบบย่อ — ID เต็มไม่ออกจาก node"""
    rid = r.get("id", "")
    return {"rid": r["rid"], "name": r.get("name", ""), "hint": rid[:5] + "…" + rid[-4:], "kind": "group" if rid[:1] == "C" else "user"}


def _notify_ready(n: dict) -> bool:
    return bool(n.get("enabled") and n.get("api_key") and n.get("recipients"))


def _push_all(token: str, recipients: list[dict], text: str) -> tuple[int, int]:
    """ส่งให้ทุกคนในรายชื่อ — คืน (สำเร็จ, ล้มเหลว) ไม่หยุดกลางทางเมื่อบางคนส่งไม่ได้"""
    ok = failed = 0
    for r in recipients:
        try:
            _push_line(token, r["id"], text)
            ok += 1
        except Exception:
            failed += 1
    return ok, failed


def _push_line(token: str, to: str, text: str) -> None:
    resp = httpx.post(f"{LINE_API}/v2/bot/message/push", timeout=15,
                      headers={"Authorization": f"Bearer {token}"},
                      json={"to": to, "messages": [{"type": "text", "text": text[:4800]}]})
    if resp.status_code >= 400:
        raise err(502, "notify_failed", "LINE rejected the message", line_status=resp.status_code)


def _notify_text(n: dict, doc: dict) -> str:
    labels = [i.get("label") or i["code"] for i in (doc.get("check") or {}).get("issues", [])]
    template = (n.get("template") or "").strip() or "{file}: {issues}"
    return (template.replace("{file}", doc.get("filename", "")).replace("{count}", str(len(labels)))
            .replace("{issues}", ", ".join(labels)))


def _notify_doc(doc: dict) -> None:
    n = load_settings().get("notify") or {}
    if not _notify_ready(n) or (doc["status"] != "failed" and (doc.get("check") or {}).get("ok")):
        return
    ok, failed = _push_all(n["api_key"], n["recipients"], _notify_text(n, doc))
    doc["notified"] = "sent" if ok and not failed else ("partial" if ok else "failed")


# ── กฎตรวจ ───────────────────────────────────────────

@app.get("/api/rules")
def rules_list():
    _ensure_default_rule()
    return {"rules": db_all("rules")}


@app.post("/api/rules")
def rule_create(req: RuleIn):
    rid = _new_id()
    db_put("rules", rid, _rule_from_input(req, rid))
    return db_get("rules", rid)


@app.put("/api/rules/{rule_id}")
def rule_update(rule_id: str, req: RuleIn):
    old = _rule(rule_id)
    db_put("rules", rule_id, _rule_from_input(req, rule_id, old))
    return db_get("rules", rule_id)


@app.delete("/api/rules/{rule_id}")
def rule_delete(rule_id: str):
    if rule_id == DEFAULT_RULE_ID:
        raise err(400, "rule_default_locked", "The default rule set cannot be deleted")
    _rule(rule_id)
    db_delete("rules", rule_id)
    return {"ok": True}


# ── เอกสาร ───────────────────────────────────────────

@app.post("/api/docs")
def doc_upload(file: UploadFile = File(...), rule_id: str = Form(default="")):
    name = _safe_filename(file.filename or "document")
    mime = OCR_SUFFIX_MIME.get(Path(name).suffix.lower())
    if not mime:
        raise err(400, "ocr_file_type", "Unsupported file type", allowed=", ".join(sorted(OCR_SUFFIX_MIME)))
    data = file.file.read(MAX_OCR_MB * 1024 * 1024 + 1)
    if not data:
        raise err(400, "ocr_empty", "The file is empty")
    if len(data) > MAX_OCR_MB * 1024 * 1024:
        raise err(413, "ocr_too_large", "The file is too large", max_mb=MAX_OCR_MB)
    rule = _rule(rule_id)
    s = load_settings()
    creds = {"llm": model_creds(s, resolve_model(s, "llm")[1])}
    if not creds["llm"]:
        raise err(400, "llm_missing", "Set up an AI model first")
    _await_tunnel(creds)
    with _ocr_slots:
        res = _central_ocr(name, data, mime, creds)
    add_usage(res.pop("usage", None))
    doc = {"id": _new_id(), "filename": name, "size": len(data), "rule_id": rule["id"],
           "document_type": str(res.get("document_type") or "unknown"), "raw_text": str(res.get("raw_text") or ""),
           "fields": res.get("fields") or [], "overall_confidence": float(res.get("overall_confidence") or 0),
           "parse_error": bool(res.get("parse_error")), "created_at": _now(), "approved_at": None,
           "approved_by": None, "notified": None}
    doc["check"] = run_checks(doc, rule)
    if doc["parse_error"]:
        doc["status"] = "failed"
    elif doc["check"]["ok"] and rule.get("auto_approve"):
        doc.update(status="approved", approved_at=_now(), approved_by="auto")
    else:
        doc["status"] = "pending_review"
    _notify_doc(doc)
    db_put("docs", doc["id"], doc)
    return _doc_public(doc, detail=True)


@app.get("/api/docs")
def docs_list(status: str = "", limit: int = 500):
    rows = [d for d in db_all("docs") if not status or d.get("status") == status]
    rows.sort(key=lambda d: d.get("created_at") or "", reverse=True)
    return {"docs": [_doc_public(d) for d in rows[:max(1, min(limit, 2000))]],
            "counts": {st: sum(1 for d in db_all("docs") if d.get("status") == st) for st in DOC_STATUSES}}


@app.get("/api/docs/export.csv")
def docs_export():
    import csv
    import io
    buf = io.StringIO()
    out = csv.writer(buf)
    out.writerow(["id", "filename", "document_type", "status", "check_ok", "issues", "created_at", "approved_at", "fields_json"])
    for d in sorted(db_all("docs"), key=lambda d: d.get("created_at") or ""):
        chk = d.get("check") or {}
        out.writerow([d["id"], d.get("filename", ""), d.get("document_type", ""), d.get("status", ""),
                      "1" if chk.get("ok") else "0",
                      ";".join(i.get("label") or i["code"] for i in chk.get("issues", [])),
                      d.get("created_at", ""), d.get("approved_at") or "",
                      json.dumps(d.get("fields") or [], ensure_ascii=False)])
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="ocr-documents.csv"'})


@app.get("/api/docs/{doc_id}")
def doc_get(doc_id: str):
    return _doc_public(_doc(doc_id), detail=True)


@app.put("/api/docs/{doc_id}")
def doc_edit(doc_id: str, req: DocEditIn):
    doc = _doc(doc_id)
    fields = []
    for f in req.fields[:300]:
        if isinstance(f, dict):
            fields.append({"label": str(f.get("label", ""))[:200], "value": str(f.get("value", ""))[:5000],
                           "confidence": max(0.0, min(1.0, float(f.get("confidence") or 0)))})
    doc["fields"] = fields
    rule = _rule(doc.get("rule_id") or DEFAULT_RULE_ID)
    doc["check"] = run_checks({**doc, "parse_error": False}, rule)
    if req.approve:
        doc.update(status="approved", approved_at=_now(), approved_by="user")
    elif doc["status"] == "failed" and fields:
        doc["status"] = "pending_review"
    db_put("docs", doc_id, doc)
    return _doc_public(doc, detail=True)


@app.delete("/api/docs/{doc_id}")
def doc_delete(doc_id: str):
    _doc(doc_id)
    db_delete("docs", doc_id)
    return {"ok": True}


@app.post("/api/admin/notify/test")
def notify_test(body: dict = Body(default={})):
    """ทดสอบส่ง: ระบุ rid = ส่งให้คนเดียว, ไม่ระบุ = ส่งให้ทุกคนในรายชื่อ"""
    n = load_settings().get("notify") or {}
    token = str(body.get("api_key") or n.get("api_key") or "").strip()
    people = n.get("recipients") or []
    if body.get("rid"):
        people = [r for r in people if r["rid"] == body["rid"]]
    if not (token and people):
        raise err(400, "notify_incomplete", "Enter the LINE channel token and add a receiver")
    ok, failed = _push_all(token, people, str(body.get("text") or "1n9 OCR"))
    if not ok:
        raise err(502, "notify_failed", "LINE did not accept the message")
    return {"ok": True, "sent": ok, "failed": failed}


@app.post("/api/admin/notify/recipients")
def notify_add_recipient(body: dict = Body(...)):
    rid = str(body.get("id") or "").strip()
    name = str(body.get("name") or "").strip()[:60]
    if not _LINE_ID_RE.match(rid):
        raise err(400, "notify_bad_id", "The ID is not a LINE user or group ID")
    s = load_settings()
    people = list(s["notify"].get("recipients") or [])
    if any(r["id"] == rid for r in people):
        raise err(409, "notify_duplicate", "This receiver is already in the list")
    if len(people) >= NOTIFY_MAX_RECIPIENTS:
        raise err(400, "notify_too_many", "Too many receivers", max=NOTIFY_MAX_RECIPIENTS)
    people.append({"rid": _new_id(), "id": rid, "name": name})
    _write_settings({**s, "notify": {**s["notify"], "recipients": people}})
    return {"recipients": [_recipient_public(r) for r in people]}


@app.delete("/api/admin/notify/recipients/{rid}")
def notify_remove_recipient(rid: str):
    s = load_settings()
    people = [r for r in (s["notify"].get("recipients") or []) if r["rid"] != rid]
    _write_settings({**s, "notify": {**s["notify"], "recipients": people}})
    return {"recipients": [_recipient_public(r) for r in people]}


# ══════════════════════════════════════════════
# หน้าเว็บ (Next.js static export) — mount ท้ายสุดเพื่อไม่ทับ /api
# ══════════════════════════════════════════════

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    @app.get("/")
    def _no_frontend():
        return JSONResponse({"detail": {"code": "frontend_missing", "message": f"Frontend not built ({FRONTEND_DIR})"}},
                            status_code=503)
