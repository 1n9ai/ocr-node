"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BadgeCheck, CheckCircle2, Loader2, Plus, Save, Trash2, TriangleAlert } from "lucide-react";
import { ErrorNote, Loading, PageHeader } from "@/components/Shell";
import { StatusChip } from "@/components/StatusChip";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { deleteDoc, getDoc, saveDoc } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { OcrDoc, OcrField, OcrIssue } from "@/lib/types";

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const tone = pct >= 85 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-2" title={`${pct}%`}>
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-accent-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-accent-500">{pct}%</span>
    </div>
  );
}

export default function DocPage() {
  const { t, errorText, fmtDateTime } = useI18n();
  const [id, setId] = useState<string | null>(null);
  const [doc, setDoc] = useState<OcrDoc | null>(null);
  const [fields, setFields] = useState<OcrField[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get("id"));
  }, []);

  const load = useCallback(
    async (docId: string) => {
      const d = await getDoc(docId);
      setDoc(d);
      setFields(d.fields.map((f) => ({ ...f })));
      setDirty(false);
    },
    [],
  );

  useEffect(() => {
    if (id === null) return;
    load(id).catch((e) => setError(errorText(e)));
  }, [id, load, errorText]);

  if (!doc) return error ? <ErrorNote message={error} /> : <Loading />;

  const edit = (i: number, patch: Partial<OcrField>) => {
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch, confidence: patch.value !== undefined ? 1 : f.confidence } : f)));
    setDirty(true);
  };

  async function submit(approve: boolean) {
    if (!doc) return;
    setBusy(approve ? "approve" : "save");
    setError(null);
    try {
      const next = await saveDoc(doc.id, fields.filter((f) => f.label.trim() || f.value.trim()), approve);
      setDoc(next);
      setFields(next.fields.map((f) => ({ ...f })));
      setDirty(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!doc || !window.confirm(t("doc.delete_confirm", { name: doc.filename }))) return;
    try {
      await deleteDoc(doc.id);
      window.location.replace("/");
    } catch (e) {
      setError(errorText(e));
    }
  }

  const issueText = (i: OcrIssue) =>
    t(`doc.issue.${i.code}`, { label: i.label, pct: i.confidence !== undefined ? Math.round(i.confidence * 100) : undefined });
  const issues = doc.check?.issues ?? [];

  return (
    <div>
      <Link href="/" className="mb-4 inline-flex items-center gap-1.5 text-sm text-accent-500 hover:text-brand-700">
        <ArrowLeft size={15} /> {t("doc.back")}
      </Link>
      <PageHeader
        title={doc.filename}
        description={`${doc.document_type} · ${fmtDateTime(doc.created_at)}`}
        actions={
          <>
            <StatusChip status={doc.status} check={doc.check} />
            <Button variant="ghost" onClick={remove} aria-label={t("common.delete")}>
              <Trash2 size={15} />
            </Button>
          </>
        }
      />
      <ErrorNote message={error} />

      {doc.status === "approved" && (
        <p className="mb-4 flex items-center gap-1.5 text-sm font-medium text-emerald-700">
          <BadgeCheck size={16} /> {doc.approved_by === "auto" ? t("doc.approved_auto") : t("doc.approved_at", { date: fmtDateTime(doc.approved_at) })}
        </p>
      )}
      {doc.notified && (
        <p className={`mb-4 text-xs ${doc.notified === "sent" ? "text-accent-500" : "text-rose-600"}`}>{t(`doc.notified.${doc.notified}`)}</p>
      )}

      {issues.length > 0 ? (
        <div className="mb-5 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
          <p className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <TriangleAlert size={15} /> {t("doc.issues")}
          </p>
          <ul className="list-disc pl-5 text-sm text-amber-900">
            {issues.map((i, k) => (
              <li key={k}>{issueText(i)}</li>
            ))}
          </ul>
        </div>
      ) : (
        doc.status !== "failed" && (
          <p className="mb-5 flex items-center gap-1.5 text-sm font-medium text-emerald-700">
            <CheckCircle2 size={16} /> {t("docs.check.pass")}
          </p>
        )
      )}

      <Card hover={false} className="mb-5">
        <h2 className="mb-3 text-sm font-semibold text-accent-900">{t("doc.fields")}</h2>
        <div className="flex flex-col gap-2">
          {fields.map((f, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 border-b border-accent-100 pb-3 last:border-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto] sm:border-0 sm:pb-0">
              <input className="field order-1" aria-label={t("doc.field.label")} placeholder={t("doc.field.label")} value={f.label} onChange={(e) => edit(i, { label: e.target.value })} />
              <input
                className="field order-3 col-span-2 sm:order-2 sm:col-span-1"
                aria-label={t("doc.field.value")}
                placeholder={t("doc.field.value")}
                value={f.value}
                onChange={(e) => edit(i, { value: e.target.value })}
              />
              <div className="order-4 col-span-2 sm:order-3 sm:col-span-1">
                <ConfidenceBar value={f.confidence} />
              </div>
              <button
                type="button"
                aria-label={t("common.remove")}
                onClick={() => {
                  setFields((fs) => fs.filter((_, j) => j !== i));
                  setDirty(true);
                }}
                className="order-2 rounded-lg p-2 text-accent-400 hover:bg-rose-50 hover:text-rose-600 sm:order-4"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {fields.length === 0 && <p className="text-sm text-accent-400">{t("doc.no_fields")}</p>}
        </div>
        <button
          type="button"
          onClick={() => {
            setFields((fs) => [...fs, { label: "", value: "", confidence: 1 }]);
            setDirty(true);
          }}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent-500 hover:text-brand-700"
        >
          <Plus size={15} /> {t("doc.field.add")}
        </button>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={!dirty || busy !== null} onClick={() => submit(false)}>
            {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t("doc.save")}
          </Button>
          {doc.status !== "approved" && (
            <Button disabled={busy !== null} onClick={() => submit(true)}>
              {busy === "approve" ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />} {t("doc.approve")}
            </Button>
          )}
        </div>
      </Card>

      <Card hover={false}>
        <h2 className="mb-3 text-sm font-semibold text-accent-900">{t("doc.raw")}</h2>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-accent-50 p-4 font-mono text-[12.5px] leading-relaxed text-accent-700">
          {doc.raw_text || "—"}
        </pre>
      </Card>
    </div>
  );
}
