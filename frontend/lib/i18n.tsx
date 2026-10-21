"use client";

// ระบบภาษากลาง: ข้อความทุกตัวมาจาก locales/*.json เท่านั้น (ห้ามฝังในหน้าจอ — scripts/check-i18n.mjs ตรวจตอน build)
// เพิ่มภาษาใหม่ = เพิ่มไฟล์ json หนึ่งไฟล์ + ใส่ใน DICTS/LOCALES ด้านล่าง

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";
import th from "@/locales/th.json";
import zh from "@/locales/zh.json";
import { ApiError } from "@/lib/api";

export const LANGS = ["th", "en", "ja", "zh"] as const;
export type Lang = (typeof LANGS)[number];
type Dict = Record<string, string>;
type Params = Record<string, string | number | undefined | null>;

const DICTS: Record<Lang, Dict> = { th, en, ja, zh };
// รูปแบบวันที่ตามภาษา — th-TH แสดงปี พ.ศ. ให้เอง
const LOCALES: Record<Lang, string> = { th: "th-TH", en: "en-US", ja: "ja-JP", zh: "zh-CN" };
const STORAGE_KEY = "lang";

function pickInitial(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LANGS as readonly string[]).includes(saved)) return saved as Lang;
  } catch {
    /* โหมดส่วนตัว/ปิด storage — ใช้ภาษาจากเบราว์เซอร์ */
  }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "").toLowerCase();
  return (LANGS.find((l) => nav.startsWith(l)) as Lang | undefined) ?? "en";
}

function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

type I18n = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Params) => string;
  has: (key: string) => boolean;
  nativeName: (l: Lang) => string;
  fmtDate: (iso?: string | null) => string;
  fmtDateTime: (iso?: string | null) => string;
  fmtMoney: (amountMinor: number, currency: string, divide?: number) => string;
  /** ข้อความ error ในภาษาที่เลือก: แปลจากรหัส ถ้าไม่มีคำแปลใช้ข้อความสำรองจากเซิร์ฟเวอร์ */
  errorText: (e: unknown) => string;
  codeText: (code?: string | null, fallback?: string | null, params?: Params) => string;
};

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang | null>(null);

  useEffect(() => {
    setLangState(pickInitial());
  }, []);

  useEffect(() => {
    if (lang) document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ไม่จำก็ไม่เป็นไร */
    }
  }, []);

  const value = useMemo<I18n | null>(() => {
    if (!lang) return null;
    const dict = DICTS[lang];
    const has = (key: string) => key in dict || key in DICTS.en;
    const t = (key: string, params?: Params) => fill(dict[key] ?? DICTS.en[key] ?? key, params);
    const codeText = (code?: string | null, fallback?: string | null, params?: Params) =>
      code && has(`errors.${code}`) ? t(`errors.${code}`, params) : fallback || t("errors.unknown");
    const errorText = (e: unknown) => {
      if (e instanceof ApiError) return codeText(e.code, e.message, e.params as Params);
      if (e instanceof TypeError) return t("errors.network"); // fetch ไม่ถึงเซิร์ฟเวอร์
      return t("errors.unknown");
    };
    const date = (iso: string | null | undefined, opts: Intl.DateTimeFormatOptions) => {
      if (!iso) return "";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(LOCALES[lang], opts).format(d);
    };
    return {
      lang,
      setLang,
      t,
      has,
      nativeName: (l: Lang) => DICTS[l]["lang.native"] ?? l,
      fmtDate: (iso) => date(iso, { dateStyle: "medium" }),
      fmtDateTime: (iso) => date(iso, { dateStyle: "medium", timeStyle: "short" }),
      fmtMoney: (amountMinor, currency, divide = 1) =>
        new Intl.NumberFormat(LOCALES[lang], { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format(
          amountMinor / 100 / divide,
        ),
      errorText,
      codeText,
    };
  }, [lang, setLang]);

  // ยังไม่รู้ภาษา (ก่อนอ่าน localStorage) — ไม่แสดงอะไร กันข้อความกระพริบเปลี่ยนภาษา
  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n must be used inside I18nProvider");
  return v;
}
