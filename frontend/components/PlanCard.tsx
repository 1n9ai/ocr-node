"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CreditCard, Loader2, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getBillingStatus, openBillingPortal, startCheckout } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { BillingStatus } from "@/lib/types";

// แพ็กเกจ/ชำระเงิน — ราคามาจาก Stripe ผ่าน central (ไม่ฝังในหน้า) · central ไม่เปิดระบบชำระเงิน = ไม่แสดงอะไร
export function PlanCard({ onActivated }: { onActivated: () => void }) {
  const { t, errorText, fmtMoney } = useI18n();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("billing");
    if (result) window.history.replaceState(null, "", window.location.pathname);

    async function load() {
      const b = await getBillingStatus().catch(() => null);
      if (alive) setBilling(b);
      return b;
    }

    if (result === "cancel") setNote({ ok: false, text: t("plan.cancelled") });
    if (result === "success") {
      // webhook ของ Stripe มาถึง central ช้ากว่าการพากลับหน้านี้เล็กน้อย — รอจนสิทธิ์เปิดจริง
      setNote({ ok: true, text: t("plan.activating") });
      (async () => {
        for (let i = 0; i < 15 && alive; i++) {
          const b = await load();
          if (b?.subscription_live) {
            setNote({ ok: true, text: t("plan.activated") });
            onActivated();
            return;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (alive) setNote({ ok: false, text: t("plan.slow") });
      })();
    } else {
      load();
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function go(kind: "month" | "year" | "portal") {
    setBusy(kind);
    setNote(null);
    const returnUrl = `${window.location.origin}/settings/`;
    try {
      const { url } = kind === "portal" ? await openBillingPortal(returnUrl) : await startCheckout(kind, returnUrl);
      window.location.href = url;
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
      setBusy(null);
    }
  }

  if (!billing?.enabled) return null;
  const month = billing.prices?.month;
  const year = billing.prices?.year;
  const failed = billing.billing_status === "payment_failed" || billing.billing_status === "past_due";

  return (
    <div className="mt-3 border-t border-accent-100 pt-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-accent-900">
        <CreditCard size={15} className="text-brand-600" /> {t("plan.title")}
      </div>

      {billing.subscription_live ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-accent-600">
            {t("plan.active", { interval: billing.plan ? t(`plan.interval.${billing.plan}`) : "" })}
            {failed && <span className="ml-1 font-medium text-rose-700">{t("plan.card_failed")}</span>}
          </p>
          <Button variant="secondary" onClick={() => go("portal")} disabled={!!busy} className="px-3 py-1.5 text-xs">
            {busy === "portal" ? <Loader2 size={13} className="animate-spin" /> : <Settings2 size={13} />} {t("plan.manage")}
          </Button>
        </div>
      ) : month || year ? (
        <>
          <p className="mb-2 text-xs text-accent-500">{billing.license_type === "demo" ? t("plan.demo_hint") : t("plan.renew_hint")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {month && (
              <button
                type="button"
                onClick={() => go("month")}
                disabled={!!busy}
                className="rounded-xl p-3 text-left ring-1 ring-accent-200 transition-all hover:ring-brand-300 disabled:opacity-60"
              >
                <span className="block text-xs text-accent-500">{t("plan.monthly")}</span>
                <span className="text-lg font-semibold text-accent-900">{fmtMoney(month.amount, month.currency)}</span>
                <span className="text-xs text-accent-500"> {t("plan.per_month")}</span>
                {busy === "month" && <Loader2 size={13} className="ml-2 inline animate-spin" />}
              </button>
            )}
            {year && (
              <button
                type="button"
                onClick={() => go("year")}
                disabled={!!busy}
                className="rounded-xl p-3 text-left ring-2 ring-brand-300 transition-all hover:ring-brand-500 disabled:opacity-60"
              >
                <span className="block text-xs text-accent-500">{t("plan.yearly")}</span>
                <span className="text-lg font-semibold text-accent-900">{fmtMoney(year.amount, year.currency, 12)}</span>
                <span className="text-xs text-accent-500"> {t("plan.per_month")}</span>
                <span className="block text-[11px] text-accent-400">{t("plan.billed_yearly", { amount: fmtMoney(year.amount, year.currency) })}</span>
                {busy === "year" && <Loader2 size={13} className="ml-2 inline animate-spin" />}
              </button>
            )}
          </div>
          {billing.has_subscription && (
            <button type="button" onClick={() => go("portal")} disabled={!!busy} className="mt-2 text-xs text-accent-500 underline hover:text-accent-800">
              {t("plan.old_receipts")}
            </button>
          )}
        </>
      ) : (
        <p className="text-xs text-accent-400">{t("plan.no_prices")}</p>
      )}

      {note && (
        <p className={`mt-2 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs ${note.ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
          {note.ok && <CheckCircle2 size={14} className="mt-px shrink-0" />}
          {note.text}
        </p>
      )}
    </div>
  );
}
