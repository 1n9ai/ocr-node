"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, FileText, Globe, ListChecks, LogOut, Settings } from "lucide-react";
import { claimLicense, getAdminStatus, getMe, getSetup, logout } from "@/lib/api";
import { LANGS, useI18n, type Lang } from "@/lib/i18n";
import type { LicenseInfo } from "@/lib/types";

const NAV = [
  { href: "/", key: "nav.docs", icon: FileText, match: (p: string) => p === "/" || p.startsWith("/doc") },
  { href: "/rules/", key: "nav.rules", icon: ListChecks, match: (p: string) => p.startsWith("/rules") },
  { href: "/settings/", key: "nav.settings", icon: Settings, match: (p: string) => p.startsWith("/settings") },
];

function LanguageSwitcher() {
  const { lang, setLang, nativeName, t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("nav.language")}
        className="flex items-center gap-1.5 rounded-xl bg-white/80 px-2.5 py-1.5 text-xs font-medium text-accent-700 ring-1 ring-accent-200 transition-colors hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        <Globe size={14} className="text-accent-400" aria-hidden />
        <span lang={lang}>{nativeName(lang)}</span>
        <ChevronDown size={13} className={`text-accent-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <ul role="listbox" aria-label={t("nav.language")} className="absolute right-0 top-full z-50 mt-2 min-w-[10rem] overflow-hidden rounded-xl bg-white p-1 shadow-lg ring-1 ring-accent-200">
          {LANGS.map((l) => {
            const selected = l === lang;
            return (
              <li key={l} role="option" aria-selected={selected}>
                <button
                  type="button"
                  lang={l}
                  onClick={() => {
                    setLang(l);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                    selected ? "bg-brand-50 font-semibold text-brand-700" : "text-accent-700 hover:bg-accent-50"
                  }`}
                >
                  <span>{nativeName(l)}</span>
                  {selected && <Check size={14} aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LicensePill() {
  const { t, fmtDate } = useI18n();
  const [lic, setLic] = useState<LicenseInfo | null>(null);

  useEffect(() => {
    getAdminStatus()
      .then((s) => setLic(s.license))
      .catch(() => setLic(null));
  }, []);

  if (!lic) return null;
  return lic.ok ? (
    <Link href="/settings/" className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 sm:flex">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      {t("license.ok")}
      {lic.valid_until ? <span className="text-emerald-600/80">{t("license.until", { date: fmtDate(lic.valid_until) })}</span> : null}
    </Link>
  ) : (
    <Link
      href="/settings/"
      aria-label={t("license.problem")}
      title={t("license.problem")}
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200"
    >
      <span className="h-2 w-2 rounded-full bg-rose-500" />
      <span className="hidden sm:inline">{t("license.problem")}</span>
    </Link>
  );
}

function LicenseBanner() {
  const { t, errorText } = useI18n();
  const [displaced, setDisplaced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminStatus()
      .then((s) => setDisplaced(!!s.license?.displaced))
      .catch(() => undefined);
  }, []);

  if (!displaced) return null;
  async function claim() {
    if (!window.confirm(t("license.claim_confirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await claimLicense();
      window.location.reload();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t("license.displaced_title")}</p>
        <p className="mt-0.5 text-xs">{t("license.displaced_body")}</p>
        {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
      </div>
      <button
        type="button"
        onClick={claim}
        disabled={busy}
        className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold shadow-soft ring-1 ring-inset ring-black/5 disabled:opacity-60"
      >
        {t("license.claim")}
      </button>
    </div>
  );
}

function NavLinks({ pathname, variant }: { pathname: string; variant: "inline" | "tabs" }) {
  const { t } = useI18n();
  return (
    <>
      {NAV.map((item) => {
        const active = item.match(pathname.replace(/\/$/, "") || "/");
        const Icon = item.icon;
        const base = variant === "tabs" ? "flex min-w-0 flex-auto items-center justify-center gap-1.5 px-2.5 py-2 text-[13px]" : "flex shrink-0 items-center gap-1.5 px-3 py-2";
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${base} rounded-xl transition-all ${variant === "tabs" ? "" : "text-sm"} ${
              active ? "bg-ink bg-ink-grad font-medium text-white shadow-ink" : "text-accent-600 hover:bg-white hover:text-accent-900"
            }`}
          >
            <Icon size={15} className={`shrink-0 ${active ? "text-brand-300" : "text-accent-400"}`} />
            <span className="truncate">{t(item.key)}</span>
          </Link>
        );
      })}
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const { t } = useI18n();
  const onSetup = pathname.startsWith("/setup");
  const onLogin = pathname.startsWith("/login");
  const [signedIn, setSignedIn] = useState(false);

  // not signed in -> sign-in page; signed in but not set up (license, AI connection) -> first-run setup
  useEffect(() => {
    if (onLogin) return;
    getMe()
      .then((me) => {
        if (me.auth_required && !me.authenticated) {
          window.location.replace(`/login/?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setSignedIn(me.auth_required);
        if (!onSetup) return getSetup().then((s) => s.needs_setup && window.location.replace("/setup/"));
      })
      .catch(() => undefined);
  }, [onSetup, onLogin, pathname]);

  async function signOut() {
    await logout().catch(() => undefined);
    window.location.replace("/login/");
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-white/70 bg-white/75 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 md:h-16 md:gap-4">
          <Link href="/" className="flex min-w-0 shrink-0 items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/1n9-icon.svg" alt="" width={30} height={30} className="h-[30px] w-[30px] shrink-0 drop-shadow-sm" />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold text-accent-900">{t("app.name")}</span>
              <span className="hidden truncate text-[10px] font-medium uppercase tracking-[0.2em] text-accent-400 lg:block">{t("app.tagline")}</span>
            </span>
          </Link>
          {!onSetup && !onLogin && (
            <nav className="hidden flex-1 items-center gap-1 md:flex">
              <NavLinks pathname={pathname} variant="inline" />
            </nav>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {!onSetup && !onLogin && <LicensePill />}
            <LanguageSwitcher />
            {signedIn && (
              <button
                type="button"
                onClick={signOut}
                aria-label={t("login.logout")}
                title={t("login.logout")}
                className="flex shrink-0 items-center rounded-xl bg-white/80 p-2 text-accent-500 ring-1 ring-accent-200 transition-colors hover:bg-white hover:text-accent-900"
              >
                <LogOut size={15} />
              </button>
            )}
          </div>
        </div>
        {!onSetup && !onLogin && (
          <nav className="border-t border-white/70 px-3 py-1.5 md:hidden">
            <div className="mx-auto flex max-w-md items-center gap-1">
              <NavLinks pathname={pathname} variant="tabs" />
            </div>
          </nav>
        )}
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {!onSetup && !onLogin && <LicenseBanner />}
        {children}
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="title-grad text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-accent-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="mb-4 rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{message}</p>;
}

export function Loading() {
  const { t } = useI18n();
  return <p className="text-sm text-accent-400">{t("common.loading")}</p>;
}
