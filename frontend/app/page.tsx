"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, FileText, Loader2, TriangleAlert, Upload, XCircle } from "lucide-react";
import { ErrorNote, Loading, PageHeader } from "@/components/Shell";
import { StatusChip } from "@/components/StatusChip";
import { Card } from "@/components/ui/Card";
import { exportUrl, listDocs, listRules, uploadDoc } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { DocCounts, DocStatus, OcrDocSummary, OcrRule } from "@/lib/types";

const MAX_MB = 20;
const ACCEPT = ".jpg,.jpeg,.png,.webp,.pdf";
type Tab = DocStatus | "all";
type Upload = { key: number; name: string; state: "reading" | "done" | "error"; message?: string };

export default function DocumentsPage() {
  const { t, errorText, fmtDateTime } = useI18n();
  const [docs, setDocs] = useState<OcrDocSummary[] | null>(null);
  const [counts, setCounts] = useState<DocCounts>({ pending_review: 0, approved: 0, failed: 0 });
  const [rules, setRules] = useState<OcrRule[]>([]);
  const [ruleId, setRuleId] = useState("default");
  const [tab, setTab] = useState<Tab>("pending_review");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const busy = uploads.some((u) => u.state === "reading");

  const load = useCallback(async () => {
    const [d, r] = await Promise.all([listDocs(), listRules()]);
    setDocs(d.docs);
    setCounts(d.counts);
    setRules(r.rules);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load, errorText]);

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setError(null);
    const items = list.map((f) => ({ key: ++seq.current, name: f.name, state: "reading" as const }));
    setUploads((u) => [...items, ...u].slice(0, 12));
    for (let i = 0; i < list.length; i++) {
      const key = items[i].key;
      try {
        await uploadDoc(list[i], ruleId);
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "done" } : x)));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "error", message: errorText(e) } : x)));
      }
      await load().catch(() => undefined);
    }
  }

  if (!docs) return error ? <ErrorNote message={error} /> : <Loading />;

  const total = counts.pending_review + counts.approved + counts.failed;
  const shown = docs.filter((d) => tab === "all" || d.status === tab);
  const tabs: [Tab, number][] = [
    ["pending_review", counts.pending_review],
    ["approved", counts.approved],
    ["failed", counts.failed],
    ["all", total],
  ];

  return (
    <div>
      <PageHeader
        title={t("docs.title")}
        description={t("docs.subtitle")}
        actions={
          total > 0 ? (
            <a
              href={exportUrl()}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-medium text-accent-800 shadow-soft ring-1 ring-inset ring-accent-200 hover:ring-brand-300"
            >
              <Download size={15} /> {t("docs.export")}
            </a>
          ) : undefined
        }
      />
      <ErrorNote message={error} />

      <Card hover={false} className="mb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-accent-900">{t("docs.upload.title")}</h2>
          {rules.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-accent-600">
              {t("docs.upload.rule")}
              <select className="field !w-auto !py-1.5" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
                {rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || t("rules.default")}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors ${
            over ? "border-brand-400 bg-brand-50/50" : "border-accent-300 hover:border-brand-400 hover:bg-brand-50/30"
          }`}
        >
          <Upload size={24} className="text-accent-400" aria-hidden />
          <p className="text-sm font-medium text-accent-700">{t("docs.upload.drop")}</p>
          <p className="text-xs text-accent-400">{t("docs.upload.hint", { mb: MAX_MB })}</p>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {uploads.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5 text-sm" aria-live="polite">
            {uploads.map((u) => (
              <li key={u.key} className="flex items-start gap-2">
                {u.state === "reading" ? (
                  <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-accent-400" />
                ) : u.state === "done" ? (
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle size={15} className="mt-0.5 shrink-0 text-rose-600" />
                )}
                <span className="min-w-0 break-words text-accent-700">
                  {u.state === "reading" ? t("docs.upload.reading", { name: u.name }) : u.state === "error" ? `${u.name} — ${u.message}` : u.name}
                </span>
              </li>
            ))}
          </ul>
        )}
        {busy && <p className="mt-2 text-xs text-accent-400">{t("docs.upload.wait")}</p>}
      </Card>

      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
        {tabs.map(([key, n]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-xl px-3.5 py-2 text-sm transition-all ${
              tab === key ? "bg-ink bg-ink-grad font-medium text-white shadow-ink" : "bg-white text-accent-600 ring-1 ring-inset ring-accent-200 hover:text-accent-900"
            }`}
          >
            {t(key === "all" ? "docs.tab.all" : `docs.status.${key}`)} <span className={tab === key ? "text-brand-200" : "text-accent-400"}>{n}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card hover={false} className="py-10 text-center text-sm text-accent-400">
          {t("docs.empty")}
        </Card>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-float ring-1 ring-accent-200/60">
          <div className="hidden grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] gap-3 border-b border-accent-100 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-accent-400 md:grid">
            <span>{t("docs.col.file")}</span>
            <span>{t("docs.col.status")}</span>
            <span>{t("docs.col.check")}</span>
            <span>{t("docs.col.date")}</span>
          </div>
          <ul className="divide-y divide-accent-100">
            {shown.map((d) => {
              const issues = d.check?.issues.length ?? 0;
              return (
                <li key={d.id}>
                  <Link
                    href={`/doc/?id=${d.id}`}
                    className="grid grid-cols-1 items-center gap-1.5 px-4 py-3 text-sm transition-colors hover:bg-accent-50/60 md:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] md:gap-3"
                  >
                    <span className="flex min-w-0 items-center gap-2 font-medium text-accent-900">
                      <FileText size={16} className="shrink-0 text-accent-400" aria-hidden />
                      <span className="truncate">{d.filename}</span>
                    </span>
                    <span>
                      <StatusChip status={d.status} check={d.check} />
                    </span>
                    <span className="flex items-center gap-1.5 text-accent-600">
                      {d.status === "failed" ? (
                        <span className="text-accent-400">—</span>
                      ) : issues === 0 ? (
                        <>
                          <CheckCircle2 size={14} className="text-emerald-600" aria-hidden /> {t("docs.check.pass")}
                        </>
                      ) : (
                        <>
                          <TriangleAlert size={14} className="text-amber-600" aria-hidden /> {t("docs.check.issues", { n: issues })}
                        </>
                      )}
                    </span>
                    <span className="text-xs text-accent-400">{fmtDateTime(d.created_at)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
