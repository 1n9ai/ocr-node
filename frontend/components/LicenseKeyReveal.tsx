"use client";

import { useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { getLicenseKey } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/** แสดง license key ที่ใช้อยู่ — โหลดจากเครื่องเฉพาะตอนกดแสดง (ไม่ติดมากับการตั้งค่าปกติ) */
export function LicenseKeyReveal() {
  const { t } = useI18n();
  const [key, setKey] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load(): Promise<string> {
    if (key !== null) return key;
    const r = await getLicenseKey();
    setKey(r.license_key);
    return r.license_key;
  }

  async function toggle() {
    setFailed(false);
    try {
      if (!shown) await load();
      setShown(!shown);
    } catch {
      setFailed(true);
    }
  }

  async function copy() {
    setFailed(false);
    try {
      const k = await load();
      await navigator.clipboard.writeText(k);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="mt-4 rounded-xl bg-accent-50 px-4 py-3 ring-1 ring-inset ring-accent-200/60">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound size={16} className="shrink-0 text-accent-500" />
        <span className="text-sm font-medium text-accent-900">{t("license.reveal.title")}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-accent-700">
          {shown && key !== null ? key || t("license.reveal.none") : "•••• •••• ••••"}
        </code>
        <button type="button" onClick={toggle} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-accent-600 hover:bg-white">
          {shown ? <EyeOff size={14} /> : <Eye size={14} />} {shown ? t("license.reveal.hide") : t("license.reveal.show")}
        </button>
        <button type="button" onClick={copy} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-accent-600 hover:bg-white">
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("license.reveal.copied") : t("license.reveal.copy")}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-accent-500">{failed ? t("license.reveal.failed") : t("license.reveal.note")}</p>
    </div>
  );
}
