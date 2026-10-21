"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { ErrorNote, Loading, PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { createRule, deleteRule, listRules, updateRule } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { OcrRule } from "@/lib/types";

type Draft = { name: string; labels: string; min: number; auto: boolean };

const toDraft = (r: OcrRule): Draft => ({ name: r.name, labels: r.required_labels.join("\n"), min: Math.round(r.min_confidence * 100), auto: r.auto_approve });

function RuleCard({ rule, onChanged, onError }: { rule: OcrRule; onChanged: () => Promise<void>; onError: (m: string | null) => void }) {
  const { t, errorText } = useI18n();
  const [draft, setDraft] = useState<Draft>(toDraft(rule));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const isDefault = rule.id === "default";
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  };

  async function save() {
    setBusy(true);
    onError(null);
    try {
      await updateRule(rule.id, {
        name: draft.name,
        required_labels: draft.labels.split("\n"),
        min_confidence: Math.max(0, Math.min(100, draft.min)) / 100,
        auto_approve: draft.auto,
      });
      setSaved(true);
      await onChanged();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(t("rules.delete_confirm", { name: rule.name }))) return;
    try {
      await deleteRule(rule.id);
      await onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  }

  return (
    <Card hover={false}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <input className="field max-w-xs !font-semibold" aria-label={t("rules.name")} placeholder={isDefault ? t("rules.default") : t("rules.name")} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        {!isDefault && (
          <Button variant="ghost" onClick={remove} aria-label={t("common.delete")}>
            <Trash2 size={15} />
          </Button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="field-label">{t("rules.required")}</label>
          <textarea className="field h-36 resize-y font-mono text-[13px]" value={draft.labels} onChange={(e) => set({ labels: e.target.value })} />
          <p className="mt-1 text-xs text-accent-400">{t("rules.required_hint")}</p>
        </div>
        <div className="flex flex-col gap-4">
          <div>
            <label className="field-label">{t("rules.min_conf")}</label>
            <div className="flex items-center gap-3">
              <input type="range" min={0} max={100} step={5} value={draft.min} onChange={(e) => set({ min: Number(e.target.value) })} className="flex-1" />
              <span className="w-12 text-right text-sm tabular-nums text-accent-700">{draft.min}%</span>
            </div>
            <p className="mt-1 text-xs text-accent-400">{t("rules.min_conf_hint")}</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-accent-700">
            <input type="checkbox" className="mt-1" checked={draft.auto} onChange={(e) => set({ auto: e.target.checked })} />
            {t("rules.auto_approve")}
          </label>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {saved && (
          <span className="flex items-center gap-1 text-sm text-emerald-700">
            <Check size={15} /> {t("rules.saved")}
          </span>
        )}
        <Button onClick={save} disabled={busy}>
          {busy && <Loader2 size={15} className="animate-spin" />} {t("common.save")}
        </Button>
      </div>
    </Card>
  );
}

export default function RulesPage() {
  const { t, errorText } = useI18n();
  const [rules, setRules] = useState<OcrRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setRules((await listRules()).rules), []);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load, errorText]);

  if (!rules) return error ? <ErrorNote message={error} /> : <Loading />;

  return (
    <div>
      <PageHeader
        title={t("rules.title")}
        description={t("rules.subtitle")}
        actions={
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await createRule({ name: t("rules.new_name"), required_labels: [], min_confidence: 0.6, auto_approve: false });
                await load();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            <Plus size={15} /> {t("rules.add")}
          </Button>
        }
      />
      <ErrorNote message={error} />
      <div className="flex flex-col gap-5">
        {rules.map((r) => (
          <RuleCard key={r.id} rule={r} onChanged={load} onError={setError} />
        ))}
      </div>
    </div>
  );
}
