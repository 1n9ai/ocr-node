"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  BadgeCheck,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Database,
  KeyRound,
  ListOrdered,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldAlert,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";
import { NotifyPanel } from "@/components/NotifyPanel";
import { PlanCard } from "@/components/PlanCard";
import { ErrorNote, Loading, PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import {
  claimLicense,
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getAdminStatus,
  getSettings,
  listProviderModels,
  runFullCheck,
  saveSettings,
  setDefaultModel,
  testModel,
  testProvider,
  updateModel,
  updateProvider,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type {
  AdminStatus,
  CheckItem,
  CheckResult,
  ModelRole,
  NodeSettings,
  ProtocolId,
  ProtocolInfo,
  ProviderConn,
  ProviderModel,
  RegistryModel,
  SecretMask,
  VectorType,
} from "@/lib/types";

const KINDS: ModelRole[] = ["llm"];

// ── ตกแต่ง ────────────────────────────────────────────

const TYPE_STYLE: Record<string, string> = {
  google: "bg-sky-50 text-sky-700",
  ollama: "bg-amber-50 text-amber-700",
  openai_compatible: "bg-brand-50 text-brand-700",
};

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (name.trim().slice(0, 2) || "AI").toUpperCase();
}

function Mark({ name, type }: { name: string; type: string }) {
  return (
    <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${TYPE_STYLE[type] ?? TYPE_STYLE.openai_compatible}`}>
      {initials(name)}
    </span>
  );
}

// ── ชิ้นส่วนฟอร์ม ─────────────────────────────────────

type SecretInput = string | null; // "" = ใช้ค่าเดิม, ข้อความ = ค่าใหม่, null = ลบ
const secretOut = (v: SecretInput) => (v === null ? null : v.trim() ? v.trim() : undefined);
const NO_MASK: SecretMask = { set: false, hint: "" };

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="field-label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-accent-400">{hint}</p>}
    </div>
  );
}

function SecretField({ label, mask, value, onChange, optional }: { label: string; mask: SecretMask; value: SecretInput; onChange: (v: SecretInput) => void; optional?: boolean }) {
  const { t } = useI18n();
  const cleared = value === null;
  return (
    <Field label={label} hint={cleared ? t("common.will_remove") : mask.set ? t("common.keep_existing") : optional ? t("common.optional") : undefined}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-accent-400" />
          <input
            type="password"
            autoComplete="new-password"
            value={value ?? ""}
            disabled={cleared}
            onChange={(e) => onChange(e.target.value)}
            placeholder={mask.set ? t("common.saved_hint", { hint: mask.hint }) : t("common.paste_here")}
            className="field !pl-8"
          />
        </div>
        {mask.set && (
          <button type="button" onClick={() => onChange(cleared ? "" : null)} className="shrink-0 rounded-lg px-2.5 text-xs font-medium text-accent-500 hover:bg-accent-100">
            {cleared ? t("common.undo") : t("common.remove")}
          </button>
        )}
      </div>
    </Field>
  );
}

function Result({ item, okText }: { item?: CheckItem | null; okText?: string }) {
  const { t, codeText } = useI18n();
  if (!item) return null;
  if (item.ok === null || item.ok === undefined) return <span className="text-xs text-accent-400">{t("common.not_configured")}</span>;
  return item.ok ? (
    <span className="flex items-center gap-1 text-xs font-medium text-brand-700">
      <CheckCircle2 size={14} /> {okText ?? t("common.working")}
    </span>
  ) : (
    <span className="flex items-start gap-1 text-xs font-medium text-rose-700">
      <XCircle size={14} className="mt-px shrink-0" /> {codeText(item.error_code ?? item.code, item.message)}
    </span>
  );
}

function Note({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <p className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs ${msg.ok ? "bg-brand-50 text-brand-800" : "bg-rose-50 text-rose-700"}`}>
      {msg.ok ? <CheckCircle2 size={14} className="mt-px shrink-0" /> : <XCircle size={14} className="mt-px shrink-0" />}
      {msg.text}
    </p>
  );
}

function Panel({ icon, title, description, action, children }: { icon: ReactNode; title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="surface min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-t-2xl border-b border-accent-100 bg-gradient-to-r from-brand-50/70 via-white/0 to-white/0 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink bg-ink-grad text-brand-300 shadow-ink">{icon}</span>
          <div className="min-w-0">
            <h2 className="pt-0.5 text-sm font-semibold text-accent-900">{title}</h2>
            <p className="mt-0.5 text-xs text-accent-500">{description}</p>
          </div>
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

const EditButton = ({ onClick }: { onClick: () => void }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded-lg border border-accent-200 bg-white px-2.5 py-1.5 text-xs font-medium text-accent-700 hover:border-brand-300 hover:text-brand-700"
    >
      <Pencil size={12} /> {t("common.edit")}
    </button>
  );
};

// ── หน้าต่างเพิ่ม/แก้ไขการเชื่อมต่อ ──────────────────────

function detectType(url: string, fallback?: ProtocolId): ProtocolId {
  const u = url.trim().toLowerCase();
  if (!u) return fallback ?? "google";
  if (u.includes("generativelanguage.googleapis.com") && !u.includes("/openai")) return "google";
  if (u.includes(":11434") || u.includes("ollama")) return "ollama";
  return "openai_compatible";
}

function ConnectionModal({
  conn,
  protocols,
  onClose,
  onSaved,
}: {
  conn: ProviderConn | null; // null = เพิ่มใหม่
  protocols: Record<ProtocolId, ProtocolInfo>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t, errorText } = useI18n();
  const [name, setName] = useState(conn?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(conn?.base_url ?? "");
  const [apiKey, setApiKey] = useState<SecretInput>("");
  const [busy, setBusy] = useState<"test" | "save" | "delete" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const type = detectType(baseUrl, conn?.type);

  const body = () => ({ name, base_url: baseUrl.trim(), api_key: apiKey === null ? null : apiKey.trim() });

  async function run(kind: "test" | "save" | "delete") {
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === "test") {
        const { models } = await testProvider({ ...body(), id: conn?.id });
        setMsg({ ok: true, text: t("conn.test_ok", { n: models.length }) });
        return;
      }
      if (kind === "delete" && conn) {
        if (!window.confirm(t("conn.delete_confirm", { name: conn.name }))) return;
        await deleteProvider(conn.id);
      } else if (conn) {
        await updateProvider(conn.id, body());
      } else {
        await createProvider(body());
      }
      await onSaved();
      onClose();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={conn ? t("conn.edit_title", { name: conn.name }) : t("conn.new_title")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label={t("conn.name")} hint={t("conn.name_hint")}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("conn.name_ph")} autoFocus />
        </Field>
        <Field
          label={t("conn.url")}
          hint={
            <>
              {t("conn.url_detect", { label: protocols[type]?.label ?? type })}
              {type === "ollama" ? t("conn.url_ollama") : type === "openai_compatible" ? t("conn.url_openai") : ""}
            </>
          }
        >
          <input className="field font-mono text-[13px]" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("conn.url_ph")} spellCheck={false} />
          <p className="mt-1.5 text-[11px] leading-relaxed text-accent-400">
            {t("conn.examples")} Gemini <span className="font-mono">https://generativelanguage.googleapis.com</span> · Ollama{" "}
            <span className="font-mono">http://192.168.1.10:11434</span> · SiliconFlow <span className="font-mono">https://api.siliconflow.com/v1</span>
          </p>
        </Field>
        <SecretField
          label={type === "ollama" ? t("conn.key_ollama") : t("conn.key")}
          mask={conn?.api_key ?? NO_MASK}
          value={apiKey}
          onChange={setApiKey}
          optional={type !== "google"}
        />
        <Note msg={msg} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {conn ? (
            <Button variant="ghost" onClick={() => run("delete")} disabled={!!busy} className="text-rose-600 hover:bg-rose-50">
              {busy === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} {t("common.delete")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => run("test")} disabled={!!busy}>
              {busy === "test" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {t("common.test")}
            </Button>
            <Button onClick={() => run("save")} disabled={!!busy || !name.trim()}>
              {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t("common.save")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── หน้าต่างเพิ่ม/แก้ไขโมเดลในคลัง ───────────────────────

// ตัวอย่างเท่านั้น (กดแล้วเติมให้แก้ต่อ) — ช่องรับ JSON อะไรก็ได้ ไม่จำกัดแค่นี้ · ป้ายชื่ออยู่ใน locales (params.*)
const PARAM_EXAMPLES: Record<ModelRole, [string, string][]> = {
  llm: [
    ["params.llm.no_thinking_gemini25", '{"thinking_budget": 0}'],
    ["params.llm.low_thinking_gemini3", '{"thinking_level": "low"}'],
    ["params.llm.no_thinking_qwen3", '{"enable_thinking": false}'],
    ["params.llm.low_reasoning_openai", '{"reasoning_effort": "minimal"}'],
    ["params.llm.no_thinking_ollama", '{"think": false}'],
    ["params.llm.steady", '{"temperature": 0.2}'],
  ],
  embedding: [
    ["params.embedding.fewer_dims", '{"dimensions": 1024}'],
    ["params.embedding.gemini_docs", '{"task_type": "RETRIEVAL_DOCUMENT"}'],
  ],
  rerank: [["params.rerank.long_docs", '{"max_chunks_per_doc": 8}']],
};

function ModelModal({
  kind,
  model,
  connections,
  onClose,
  onSaved,
}: {
  kind: ModelRole;
  model: RegistryModel | null; // null = เพิ่มใหม่
  connections: ProviderConn[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t, errorText, codeText } = useI18n();
  const kindLabel = t(`kind.${kind}.label`);
  const options = kind === "rerank" ? connections.filter((c) => c.type !== "google") : connections;
  const [name, setName] = useState(model?.name ?? "");
  const [provider, setProvider] = useState(model?.provider ?? options.find((c) => c.configured)?.id ?? "");
  const [modelId, setModelId] = useState(model?.model ?? "");
  const [dim, setDim] = useState<number>(model?.dim ?? 0);
  const [makeDefault, setMakeDefault] = useState(false);
  const [list, setList] = useState<ProviderModel[] | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [paramsText, setParamsText] = useState(model?.params && Object.keys(model.params).length ? JSON.stringify(model.params, null, 2) : "");
  const [showParams, setShowParams] = useState(!!paramsText);
  // embedding ที่ตำแหน่งงานใช้อยู่ — เปลี่ยนโมเดล/มิติ/พารามิเตอร์ไม่ได้ (vector เดิมจะใช้ไม่ได้)
  const locked = kind === "embedding" && !!model?.used_by.jobs.length;

  useEffect(() => {
    setList(null);
    if (!provider || !connections.find((c) => c.id === provider)?.configured) return;
    setLoadingList(true);
    listProviderModels(provider)
      .then(({ models }) => setList(models))
      .catch(() => setList([]))
      .finally(() => setLoadingList(false));
  }, [provider, connections]);

  const suggestions = (list ?? []).filter((m) => m.kinds.includes(kind));
  const shown = suggestions.length ? suggestions : list ?? [];

  async function handleTest() {
    setBusy("test");
    setMsg(null);
    try {
      const r = await testModel({ kind, provider, model: modelId, params: paramsText });
      if (r.ok && kind === "embedding" && typeof r.dim === "number") {
        setDim(r.dim);
        setMsg({ ok: true, text: t("model.test_dim", { dim: r.dim }) });
      } else if (r.ok && kind === "llm" && typeof r.latency_ms === "number") {
        const thinking = Number(r.reasoning_tokens || 0);
        setMsg({
          ok: true,
          text: t("model.test_llm", {
            sec: (r.latency_ms / 1000).toFixed(1),
            thinking: thinking > 0 ? t("model.thinking_used", { n: thinking }) : t("model.thinking_none"),
          }),
        });
      } else {
        setMsg({ ok: !!r.ok, text: r.ok ? t("common.working") : codeText(r.error_code ?? r.code, r.message) });
      }
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    setBusy("save");
    setMsg(null);
    try {
      const body = { name: name.trim() || modelId.trim(), kind, provider, model: modelId.trim(), dim, make_default: makeDefault, params: paramsText };
      if (model) await updateModel(model.id, body);
      else await createModel(body);
      await onSaved();
      onClose();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={t(model ? "model.edit_title" : "model.add_title", { kind: kindLabel })} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {options.length === 0 ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">{t("model.no_connection")}</p>
        ) : (
          <>
            <Field label={t("model.connection")}>
              <select
                className="field"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setMsg(null);
                }}
              >
                {!provider && <option value="">{t("model.choose")}</option>}
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.configured ? "" : t("model.incomplete")}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("model.model")}
              hint={locked ? t("model.locked") : loadingList ? t("model.loading_list") : list ? t("model.found_list", { n: shown.length }) : undefined}
            >
              <input
                className="field font-mono text-[13px]"
                list="registry-model-list"
                value={modelId}
                disabled={locked}
                onChange={(e) => {
                  setModelId(e.target.value);
                  setMsg(null);
                }}
                placeholder={t("model.model_ph")}
                spellCheck={false}
              />
              <datalist id="registry-model-list">
                {shown.map((m) => (
                  <option key={m.id} value={m.id} />
                ))}
              </datalist>
            </Field>
            {kind === "embedding" && (
              <Field label={t("model.dim")} hint={locked ? t("model.locked") : t("model.dim_hint")}>
                <input type="number" min={1} className="field" value={dim || ""} disabled={locked} onChange={(e) => setDim(Number(e.target.value))} />
              </Field>
            )}
            <Field label={t("model.display")} hint={t("model.display_hint")}>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={modelId || t("model.display_ph")} />
            </Field>
            <div>
              <button type="button" onClick={() => setShowParams(!showParams)} className="flex items-center gap-1 text-xs font-medium text-accent-500 hover:text-accent-800">
                <ChevronDown size={14} className={`transition-transform ${showParams ? "rotate-180" : ""}`} /> {t("model.params")}
                {paramsText.trim() && !showParams && <span className="ml-1 rounded bg-brand-50 px-1.5 text-[10px] text-brand-700">{t("model.params_set")}</span>}
              </button>
              {showParams && (
                <div className="mt-2">
                  <textarea
                    className="field h-28 font-mono text-[12px]"
                    value={paramsText}
                    disabled={locked}
                    onChange={(e) => {
                      setParamsText(e.target.value);
                      setMsg(null);
                    }}
                    placeholder={PARAM_EXAMPLES[kind][0]?.[1] ?? "{}"}
                    spellCheck={false}
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-accent-400">{locked ? t("model.params_locked") : t("model.params_hint")}</p>
                  {!locked && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {PARAM_EXAMPLES[kind].map(([key, json]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            setParamsText(json);
                            setMsg(null);
                          }}
                          className="rounded-full bg-accent-100 px-2.5 py-1 text-[11px] text-accent-600 hover:bg-brand-50 hover:text-brand-700"
                        >
                          {t(key)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {!model?.is_default && (
              <label className="flex items-center gap-2 text-sm text-accent-700">
                <input
                  type="checkbox"
                  checked={makeDefault}
                  onChange={(e) => setMakeDefault(e.target.checked)}
                  className="h-4 w-4 rounded border-accent-300 text-brand-600 focus:ring-brand-500"
                />
                {t("model.make_default", { kind: kindLabel })}
              </label>
            )}
          </>
        )}
        <Note msg={msg} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={handleTest} disabled={!!busy || !provider || !modelId.trim()}>
            {busy === "test" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {t("common.test")}
          </Button>
          <Button onClick={handleSave} disabled={!!busy || !provider || !modelId.trim() || (kind === "embedding" && !dim)}>
            {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── กลุ่มโมเดลต่อประเภท ───────────────────────────────

const KIND_STYLE: Record<ModelRole, { icon: ReactNode; tile: string; ring: string }> = {
  llm: { icon: <MessageSquare size={18} />, tile: "bg-violet-100 text-violet-700", ring: "border-violet-200" },
  embedding: { icon: <Search size={18} />, tile: "bg-sky-100 text-sky-700", ring: "border-sky-200" },
  rerank: { icon: <ListOrdered size={18} />, tile: "bg-amber-100 text-amber-700", ring: "border-amber-200" },
};

function ModelGroup({
  kind,
  models,
  onAdd,
  onEdit,
  onDefault,
  onDelete,
}: {
  kind: ModelRole;
  models: RegistryModel[];
  onAdd: () => void;
  onEdit: (m: RegistryModel) => void;
  onDefault: (m: RegistryModel) => void;
  onDelete: (m: RegistryModel) => void;
}) {
  const { t } = useI18n();
  const style = KIND_STYLE[kind];
  const label = t(`kind.${kind}.label`);
  return (
    <div className={`flex min-w-0 flex-col rounded-xl border bg-white ${style.ring}`}>
      <div className="flex items-start gap-3 border-b border-accent-100 p-4">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${style.tile}`}>{style.icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-accent-900">{label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-accent-600">{t(`kind.${kind}.what`)}</p>
          <p className="mt-1 text-[11px] font-medium text-accent-400">→ {t(`kind.${kind}.where`)}</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3">
        {models.length === 0 && (
          <p className="rounded-lg bg-accent-50 px-3 py-3 text-center text-xs text-accent-500">
            {t("model.empty", { kind: label })}
            {kind !== "rerank" && <span className="mt-0.5 block font-medium text-amber-700">{t("model.required_note")}</span>}
          </p>
        )}
        {models.map((m) => {
          const jobs = m.used_by.jobs;
          const locked = kind === "embedding" && jobs.length ? t("model.locked_reason", { n: jobs.length }) : null;
          return (
            <div key={m.id} className={`rounded-lg border p-3 ${m.is_default ? "border-brand-300 bg-brand-50/40" : "border-accent-200"}`}>
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 break-words text-sm font-semibold text-accent-900">{m.name}</p>
                {m.is_default && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-brand-grad px-2 py-0.5 text-[11px] font-semibold text-white">
                    <Star size={11} className="fill-white" /> {t("model.default_badge")}
                  </span>
                )}
              </div>
              {m.name !== m.model && <p className="mt-1 break-all font-mono text-[11px] text-accent-500">{m.model}</p>}
              <p className="mt-0.5 text-[11px] text-accent-500">
                {t("model.via", { name: m.provider_name })}
                {kind === "embedding" && m.dim ? t("model.dims", { dim: m.dim }) : ""}
              </p>
              <p className="mt-2 text-[11px] text-accent-500">
                {jobs.length ? t("model.used_by", { names: jobs.join(", ") }) : m.is_default ? t("model.used_default") : t("model.unused")}
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-accent-100 pt-2.5">
                {!m.is_default && (
                  <button
                    type="button"
                    onClick={() => onDefault(m)}
                    className="flex items-center gap-1 rounded-md border border-accent-200 bg-white px-2 py-1 text-xs font-medium text-accent-700 hover:border-brand-300 hover:text-brand-700"
                  >
                    <Star size={12} /> {t("model.set_default")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onEdit(m)}
                  className="flex items-center gap-1 rounded-md border border-accent-200 bg-white px-2 py-1 text-xs font-medium text-accent-700 hover:border-brand-300 hover:text-brand-700"
                >
                  <Pencil size={12} /> {t("common.edit")}
                </button>
                {locked ? (
                  <span title={locked} className="ml-auto flex items-center gap-1 px-1 text-[11px] text-accent-400">
                    <Lock size={11} /> {t("model.cannot_delete")}
                  </span>
                ) : (
                  <button type="button" onClick={() => onDelete(m)} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50">
                    <Trash2 size={12} /> {t("common.delete")}
                  </button>
                )}
              </div>
              {locked && <p className="mt-1.5 text-[11px] text-accent-400">{locked}</p>}
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          className="mt-auto flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-accent-300 py-2.5 text-sm font-medium text-accent-600 hover:border-brand-400 hover:bg-brand-50/30 hover:text-brand-700"
        >
          <Plus size={15} /> {t("common.add")} {label}
        </button>
      </div>
    </div>
  );
}

// ── โครงสร้างพื้นฐาน: แสดงอย่างเดียว กดแก้ไขถึงเปิดฟอร์ม ──────

type InfraKind = "vector" | "central";

// ชื่อผลิตภัณฑ์ — ไม่ต้องแปล
const VECTOR_LABEL: Record<VectorType, string> = { local: "", qdrant: "Qdrant", pgvector: "PostgreSQL (pgvector)", pinecone: "Pinecone" };

function InfraModal({
  kind,
  settings,
  jobCount,
  onClose,
  onSaved,
}: {
  kind: InfraKind;
  settings: NodeSettings;
  jobCount: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t, errorText } = useI18n();
  const vlabel = (v: VectorType) => (v === "local" ? t("infra.vector_local") : VECTOR_LABEL[v]);
  const usesUrlType = (v: VectorType) => v === "qdrant" || v === "local";
  const isVector = kind === "vector";
  const originalType: VectorType = settings.vector.type || "qdrant";
  const [vtype, setVtype] = useState<VectorType>(originalType);
  const original = isVector ? settings.vector.url : settings.central.url;
  const [url, setUrl] = useState(original);
  const [secret, setSecret] = useState<SecretInput>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const typeChanged = isVector && vtype !== originalType;
  const changed = url.trim() !== original || secret !== "" || typeChanged;
  // ช่องที่จำเป็นของแต่ละชนิด: Qdrant ต้องมี URL, pgvector/Pinecone ต้องมีค่าลับ (ของเดิมใช้ได้ถ้าชนิดไม่เปลี่ยน)
  const hasSecret = secret !== null && (secret.trim() !== "" || (settings.vector.api_key.set && !typeChanged));
  const valid = !isVector ? !!url.trim() : usesUrlType(vtype) ? !!url.trim() : hasSecret;

  async function handleSave() {
    if (
      isVector &&
      (url.trim() !== original || typeChanged || (!usesUrlType(vtype) && secret !== "")) &&
      jobCount > 0 &&
      !window.confirm(t("infra.confirm_vector", { n: jobCount }))
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      await saveSettings(
        isVector
          ? { vector: { type: vtype, url: usesUrlType(vtype) ? url : "", api_key: secretOut(secret) } }
          : { central: { url, license_key: secretOut(secret) } },
      );
      await onSaved();
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={isVector ? t("infra.edit_vector_title") : t("infra.edit_central_title")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
          <ShieldAlert size={15} className="mt-px shrink-0" />
          {isVector ? t("infra.warn_vector") : t("infra.warn_central")}
        </p>
        {isVector && (
          <Field label={t("infra.vector_type")} hint={t(`infra.vector_hint.${vtype}`)}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(Object.keys(VECTOR_LABEL) as VectorType[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVtype(v)}
                  className={`rounded-lg px-2 py-2 text-xs font-medium ring-1 ring-inset transition ${
                    vtype === v ? "bg-brand-50 text-brand-700 ring-brand-400" : "bg-white text-accent-600 ring-accent-200 hover:ring-brand-300"
                  }`}
                >
                  {vlabel(v)}
                </button>
              ))}
            </div>
          </Field>
        )}
        {(!isVector || usesUrlType(vtype)) && (
          <Field label={isVector ? "URL" : t("infra.central_url")} hint={isVector ? t("infra.vector_url_ph") : t("infra.central_url_hint")}>
            <input className="field font-mono text-[13px]" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
          </Field>
        )}
        <SecretField
          label={!isVector ? "License key" : vtype === "pgvector" ? t("infra.connection_string") : "API key"}
          mask={!isVector ? settings.central.license_key : typeChanged ? NO_MASK : settings.vector.api_key}
          value={secret}
          onChange={setSecret}
          optional={isVector && usesUrlType(vtype)}
        />
        {isVector && vtype === "pgvector" && <p className="-mt-2 text-xs text-accent-400">{t("infra.pg_hint")}</p>}
        {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={busy || !changed || !valid}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t("infra.save_check")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function InfraCard({
  icon,
  title,
  subtitle,
  rows,
  status,
  onEdit,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  rows: [string, ReactNode][];
  status?: CheckItem | null;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-accent-200 bg-accent-50/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-accent-500 ring-1 ring-accent-200">{icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-accent-900">{title}</p>
            <p className="text-xs text-accent-500">{subtitle}</p>
          </div>
        </div>
        <EditButton onClick={onEdit} />
      </div>
      <dl className="grid gap-1.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-w-0 gap-2">
            <dt className="w-24 shrink-0 text-accent-400">{k}</dt>
            <dd className="min-w-0 break-all font-mono text-accent-700">{v}</dd>
          </div>
        ))}
      </dl>
      {status && <Result item={status} />}
    </div>
  );
}

// ── License + แพ็กเกจ ─────────────────────────────────

function LicensePanel() {
  const { t, fmtDate, codeText, errorText } = useI18n();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    getAdminStatus()
      .then(setStatus)
      .catch((e) => setErr(errorText(e)));
  }, [errorText]);

  useEffect(load, [load]);

  async function claim() {
    if (!window.confirm(t("license.claim_confirm"))) return;
    setClaiming(true);
    setErr(null);
    try {
      await claimLicense();
      load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setClaiming(false);
    }
  }

  const lic = status?.license;
  return (
    <Panel icon={<BadgeCheck size={18} />} title={t("settings.license_title")} description={t("settings.license_desc")}>
      {err && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}
      {!lic ? (
        !err && <p className="text-sm text-accent-400">{t("license.checking")}</p>
      ) : lic.displaced ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
          <div className="min-w-0 text-sm text-amber-900">
            <p className="font-semibold">{t("license.displaced_title")}</p>
            <p className="mt-0.5 text-xs">{t("license.displaced_body")}</p>
          </div>
          <Button onClick={claim} disabled={claiming}>
            {claiming ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} {t("license.claim")}
          </Button>
        </div>
      ) : lic.ok ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
          <CheckCircle2 size={16} /> {t("license.ok")}
          {lic.valid_until && <span className="font-normal text-emerald-600/80">{t("license.until", { date: fmtDate(lic.valid_until) })}</span>}
        </p>
      ) : (
        <p className="flex items-start gap-1.5 text-sm font-medium text-rose-700">
          <XCircle size={16} className="mt-0.5 shrink-0" /> {codeText(lic.code ?? lic.error_code, lic.message ?? (status?.central.ok === false ? status.central.message : null))}
        </p>
      )}
      <PlanCard onActivated={load} />
    </Panel>
  );
}

// ── หน้า ──────────────────────────────────────────────

export default function SettingsPage() {
  const { t, errorText } = useI18n();
  const [settings, setSettings] = useState<NodeSettings | null>(null);
  const [protocols, setProtocols] = useState<Record<ProtocolId, ProtocolInfo> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingConn, setEditingConn] = useState<ProviderConn | "new" | null>(null);
  const [editingModel, setEditingModel] = useState<{ kind: ModelRole; model: RegistryModel | null } | null>(null);
  const [editingInfra, setEditingInfra] = useState<InfraKind | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const res = await getSettings();
    setSettings(res.settings);
    setProtocols(res.protocols);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load, errorText]);

  if (!settings || !protocols) return error ? <ErrorNote message={error} /> : <Loading />;

  const connections = settings.providers;
  const modelsOf = (kind: ModelRole) => settings.models.filter((m) => m.kind === kind);
  const connUsage = (pid: string) => settings.models.filter((m) => m.provider === pid);
  const jobCount = new Set(settings.models.flatMap((m) => m.used_by.jobs)).size;
  const keyText = (mask: SecretMask) => (mask.set ? t("common.saved_hint", { hint: mask.hint }) : t("common.not_set"));

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function handleCheckAll() {
    setChecking(true);
    setError(null);
    try {
      setCheck(await runFullCheck());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  }

  async function afterInfraSave() {
    await load();
    await handleCheckAll();
  }

  return (
    <div>
      <PageHeader
        title={t("settings.title")}
        description={t("settings.subtitle")}
        actions={
          <Button variant="secondary" onClick={handleCheckAll} disabled={checking}>
            {checking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {t("settings.check")}
          </Button>
        }
      />
      <ErrorNote message={error} />

      {check && (
        <div className="mb-5 grid gap-2 rounded-xl border border-accent-200 bg-white p-4 sm:grid-cols-3">
          {(
            [
              ["Central", check.central],
              [t("infra.license"), check.license],
              [t("kind.llm.label"), check.llm],
            ] as [string, CheckItem | undefined][]
          ).map(([label, item], i) => (
            <div key={i} className="min-w-0 rounded-lg bg-accent-50 px-3 py-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-accent-400">{label}</p>
              {item ? <Result item={item} okText={undefined} /> : <span className="text-xs text-accent-400">—</span>}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-5">
        {/* 1) การเชื่อมต่อ */}
        <Panel icon={<Cpu size={18} />} title={t("conn.panel_title")} description={t("conn.panel_desc")}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {connections.map((c) => {
              const used = connUsage(c.id);
              return (
                <div key={c.id} className={`flex flex-col gap-3 rounded-xl border p-4 ${c.configured ? "border-accent-200 bg-white" : "border-amber-200 bg-amber-50/40"}`}>
                  <div className="flex items-start gap-3">
                    <Mark name={c.name} type={c.type} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-accent-900">{c.name}</p>
                      <p className="truncate font-mono text-[11px] text-accent-400">{c.base_url || protocols[c.type]?.label}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`text-xs ${c.configured ? "text-accent-500" : "text-amber-700"}`}>
                      {!c.configured ? t("conn.incomplete") : used.length ? t("conn.used", { n: used.length }) : t("conn.unused")}
                    </span>
                    <EditButton onClick={() => setEditingConn(c)} />
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setEditingConn("new")}
              className="flex min-h-[112px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-accent-300 text-sm font-medium text-accent-500 transition-colors hover:border-brand-400 hover:bg-brand-50/30 hover:text-brand-700"
            >
              <Plus size={18} /> {t("conn.add")}
            </button>
          </div>
        </Panel>

        {/* 2) คลังโมเดล */}
        <Panel icon={<Boxes size={18} />} title={t("models.panel_title")} description={t("models.panel_desc")}>
          <div className="grid gap-4">
            {KINDS.map((kind) => (
              <ModelGroup
                key={kind}
                kind={kind}
                models={modelsOf(kind)}
                onAdd={() => setEditingModel({ kind, model: null })}
                onEdit={(m) => setEditingModel({ kind, model: m })}
                onDefault={(m) => act(() => setDefaultModel(m.id))}
                onDelete={(m) => {
                  if (window.confirm(t("model.delete_confirm", { name: m.name }))) act(() => deleteModel(m.id));
                }}
              />
            ))}
          </div>
        </Panel>

        {/* 3) License + แพ็กเกจ */}
        <LicensePanel />

        {/* 4) แจ้งเตือน LINE */}
        <NotifyPanel notify={settings.notify} onSaved={load} />

        {/* 5) โครงสร้างพื้นฐาน — แสดงอย่างเดียว */}
        <Panel icon={<Lock size={18} />} title={t("infra.panel_title")} description={t("infra.panel_desc")}>
          <div className="grid gap-4">
            <InfraCard
              icon={<Server size={17} />}
              title={t("infra.central_title")}
              subtitle={t("infra.central_sub")}
              rows={[
                [t("infra.address"), settings.central.url || t("common.not_set")],
                [t("infra.license"), keyText(settings.central.license_key)],
              ]}
              status={check?.central && check.license ? (check.central.ok === false ? check.central : check.license) : check?.central}
              onEdit={() => setEditingInfra("central")}
            />
          </div>
        </Panel>
      </div>

      {editingConn && (
        <ConnectionModal conn={editingConn === "new" ? null : editingConn} protocols={protocols} onClose={() => setEditingConn(null)} onSaved={load} />
      )}
      {editingModel && (
        <ModelModal kind={editingModel.kind} model={editingModel.model} connections={connections} onClose={() => setEditingModel(null)} onSaved={load} />
      )}
      {editingInfra && (
        <InfraModal kind={editingInfra} settings={settings} jobCount={jobCount} onClose={() => setEditingInfra(null)} onSaved={afterInfraSave} />
      )}
    </div>
  );
}
