"use client";

import { useI18n } from "@/lib/i18n";
import type { DocStatus } from "@/lib/types";

export function StatusChip({ status, check }: { status: DocStatus; check?: { ok: boolean } }) {
  const { t } = useI18n();
  const tone =
    status === "approved"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : status === "failed"
        ? "bg-rose-50 text-rose-700 ring-rose-200"
        : check && !check.ok
          ? "bg-amber-50 text-amber-800 ring-amber-200"
          : "bg-accent-50 text-accent-700 ring-accent-200";
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>{t(`docs.status.${status}`)}</span>;
}
