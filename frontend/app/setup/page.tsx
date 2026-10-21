"use client";

import Link from "next/link";
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { CheckCircle2, Lock, KeyRound, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  discoverModels,
  finishSetup,
  getSetup,
  saveLicenseKey,
  setupAi,
  setupPassword,
  startTrial,
  type DiscoveredModel,
  type SetupEndpoint,
  type SetupStatus,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const STEPS = ["password", "license", "ai"] as const;
type Step = (typeof STEPS)[number] | "finish";

export default function SetupPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<Step>("license");

  useEffect(() => {
    getSetup()
      .then((s) => {
        setStatus(s);
        setStep(!s.has_password ? "password" : !s.has_license ? "license" : !s.has_llm ? "ai" : "finish");
      })
      .catch(() => setStatus(null));
  }, []);

  const index = step === "finish" ? STEPS.length : STEPS.indexOf(step);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <header>
        <h1 className="title-grad text-2xl font-semibold tracking-tight">{t("setup.title")}</h1>
        <p className="mt-1.5 text-sm text-accent-500">{t("setup.subtitle")}</p>
      </header>

      {step !== "finish" && (
        <div className="flex items-center gap-3">
          <div className="flex flex-1 gap-1.5">
            {STEPS.map((s, i) => (
              <span key={s} className={`h-1.5 flex-1 rounded-full ${i <= index ? "bg-brand-grad" : "bg-accent-200"}`} />
            ))}
          </div>
          <span className="shrink-0 text-xs text-accent-500">{t("setup.step", { n: index + 1, total: STEPS.length })}</span>
        </div>
      )}

      {!status ? (
        <Loader2 className="mx-auto animate-spin text-accent-400" />
      ) : step === "password" ? (
        <PasswordStep status={status} onDone={(s) => (setStatus(s), setStep("license"))} />
      ) : step === "license" ? (
        <LicenseStep status={status} onDone={(s) => (setStatus(s), setStep("ai"))} />
      ) : step === "ai" ? (
        <AiStep status={status} onBack={() => setStep("license")} onDone={(s) => (setStatus(s), setStep("finish"))} />
      ) : (
        <FinishStep />
      )}
    </div>
  );
}

function Card({ icon, title, desc, children }: { icon: ReactNode; title: string; desc: string; children: ReactNode }) {
  return (
    <section className="surface flex min-w-0 flex-col gap-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink bg-ink-grad text-brand-300 shadow-ink">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-accent-900">{title}</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-accent-500">{desc}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Ready({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700">
      <CheckCircle2 size={16} /> {text}
    </p>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{text}</p> : null;
}

function useAction<T>() {
  const { errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run(fn: () => Promise<T>, then: (v: T) => void) {
    setBusy(true);
    setErr(null);
    try {
      then(await fn());
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, err, run };
}


function PasswordStep({ status, onDone }: { status: SetupStatus; onDone: (s: SetupStatus) => void }) {
  const { t } = useI18n();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const { busy, err, run } = useAction<SetupStatus>();
  const ok = pw.length >= 8 && pw === pw2;

  return (
    <Card icon={<Lock size={18} />} title={t("setup.password.title")} desc={t("setup.password.desc")}>
      {status.password_from_env ? (
        <Ready text={t("setup.password.from_env")} />
      ) : status.has_password ? (
        <Ready text={t("setup.password.ready")} />
      ) : (
        <>
          <p className="text-sm text-accent-600">{t("setup.password.user", { user: status.admin_user ?? "admin" })}</p>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">{t("setup.password.password")}</span>
            <input className="field" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">{t("setup.password.confirm")}</span>
            <input className="field" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            {pw2 && pw !== pw2 && <span className="text-xs text-rose-600">{t("setup.password.mismatch")}</span>}
          </label>
          <ErrorLine text={err} />
        </>
      )}
      <div className="flex justify-end gap-2">
        {status.has_password || status.password_from_env ? (
          <Button onClick={() => onDone(status)}>{t("setup.next")}</Button>
        ) : (
          <Button disabled={busy || !ok} onClick={() => run(() => setupPassword(pw), onDone)}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {t("setup.password.save")}
          </Button>
        )}
      </div>
    </Card>
  );
}

function LicenseStep({ status, onDone }: { status: SetupStatus; onDone: (s: SetupStatus) => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"trial" | "key">("trial");
  const [email, setEmail] = useState("");
  const [key, setKey] = useState("");
  const { busy, err, run } = useAction<SetupStatus>();
  // central says what is on offer: Free Beta (open) or a short trial
  const beta = status.program ? status.program.signup_open : true;
  const desc = beta ? t("setup.license.beta_desc") : t("setup.license.trial_desc", { hours: status.program?.trial_hours ?? 24 });

  return (
    <Card icon={<Sparkles size={18} />} title={t("setup.license.title")} desc={desc}>
      {status.has_license ? (
        <Ready text={t("setup.license.ready")} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-accent-100 p-1 text-sm">
            {(["trial", "key"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`rounded-lg px-2 py-2 font-medium transition ${tab === k ? "bg-white text-accent-900 shadow-soft" : "text-accent-500"}`}
              >
                {t(k === "key" ? "setup.license.tab_key" : beta ? "setup.license.tab_beta" : "setup.license.tab_trial")}
              </button>
            ))}
          </div>
          {tab === "trial" ? (
            <label className="flex flex-col gap-1.5">
              <span className="field-label">{t("setup.license.email")}</span>
              <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              <span className="text-xs text-accent-400">{t("setup.license.email_hint")}</span>
            </label>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="field-label">{t("setup.license.key")}</span>
              <input className="field font-mono text-[13px]" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
              <span className="text-xs text-accent-400">{t("setup.license.key_hint")}</span>
            </label>
          )}
          <ErrorLine text={err} />
        </>
      )}
      <div className="flex justify-end">
        {status.has_license ? (
          <Button onClick={() => onDone(status)}>{t("setup.next")}</Button>
        ) : (
          <Button
            disabled={busy || (tab === "trial" ? !email.includes("@") : !key.trim())}
            onClick={() => run(() => (tab === "trial" ? startTrial(email.trim()) : saveLicenseKey(key.trim())), onDone)}
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {t(tab === "key" ? "setup.license.save_key" : beta ? "setup.license.start_beta" : "setup.license.start_trial")}
          </Button>
        )}
      </div>
    </Card>
  );
}

type Endpoint = SetupEndpoint;
type Kind = "llm" | "embedding" | "rerank";
type Found = { models: DiscoveredModel[]; err: string | null; busy: boolean; key: string };
const EMPTY: Endpoint = { base_url: "", api_key: "", model: "" };
const NO_FOUND: Found = { models: [], err: null, busy: false, key: "" };
const trimmed = (e: Endpoint): Endpoint => ({ base_url: e.base_url.trim(), api_key: e.api_key.trim(), model: e.model.trim() });
const endpointKey = (e: Endpoint) => `${e.base_url.trim()}|${e.api_key.trim()}`;

// Nothing is preset: the user gives an API URL (if any) + key and the models come from the provider.
function useDiscovery() {
  const { t, errorText } = useI18n();
  const [found, setFound] = useState<Found>(NO_FOUND);
  const discover = async (e: Endpoint) => {
    if (!e.api_key.trim() && !e.base_url.trim()) return;
    const key = endpointKey(e);
    setFound((f) => ({ ...f, busy: true, err: null, key }));
    try {
      const r = await discoverModels({ base_url: e.base_url.trim(), api_key: e.api_key.trim() });
      setFound({ models: r.models, err: r.models.length ? null : t("setup.ai.none_found"), busy: false, key });
    } catch (err) {
      setFound({ models: [], err: errorText(err), busy: false, key });
    }
  };
  return { found, discover };
}

function AiStep({ status, onBack, onDone }: { status: SetupStatus; onBack: () => void; onDone: (s: SetupStatus) => void }) {
  const { t } = useI18n();
  const [llm, setLlm] = useState<Endpoint>(EMPTY);
  const llmD = useDiscovery();
  const { busy, err, run } = useAction<SetupStatus>();
  const ready = status.has_llm;
  const canSave = !!(llm.model.trim() && (llm.api_key.trim() || llm.base_url.trim()));

  return (
    <Card icon={<KeyRound size={18} />} title={t("setup.ai.title")} desc={t("setup.ai.desc")}>
      {ready && <Ready text={t("setup.ai.ready")} />}
      <EndpointFields kind="llm" title={t("setup.ai.llm_title")} desc={t("setup.ai.llm_desc")} value={llm} onChange={setLlm} d={llmD} />
      <p className="text-xs leading-relaxed text-accent-400">{t("setup.ai.where_note")}</p>
      <p className="text-xs leading-relaxed text-accent-400">{t("setup.ai.privacy_note")}</p>
      <ErrorLine text={err} />
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          {t("setup.back")}
        </Button>
        <div className="flex flex-wrap gap-2">
          {ready && (
            <Button variant="secondary" onClick={() => onDone(status)}>
              {t("setup.next")}
            </Button>
          )}
          <Button disabled={busy || !canSave} onClick={() => run(() => setupAi({ llm: trimmed(llm) }), onDone)}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {t(busy ? "setup.ai.verifying" : "setup.ai.verify")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

const OTHER = "__other__";

function EndpointFields({ kind, title, desc, value, onChange, d, modelOnly = false }: {
  kind: Kind;
  title: string;
  desc: string;
  value: Endpoint;
  onChange: (v: Endpoint) => void;
  d: ReturnType<typeof useDiscovery>;
  modelOnly?: boolean;
}) {
  const { t } = useI18n();
  const [typing, setTyping] = useState(false);
  const set = (k: keyof Endpoint) => (e: ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const options = d.found.models.filter((m) => m.kinds.includes(kind));
  const stale = d.found.key !== endpointKey(value);
  const autoDiscover = () => {
    if (!modelOnly && stale && (value.api_key.trim() || value.base_url.trim())) d.discover(value);
  };
  const showSelect = options.length > 0 && !typing;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2.5 rounded-xl p-3 ring-1 ring-inset ring-accent-200">
      <div>
        <p className="text-sm font-semibold text-accent-900">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-accent-500">{desc}</p>
      </div>
      {!modelOnly && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">{t("setup.ai.base_url")}</span>
            <input
              className="field font-mono text-[13px]"
              autoComplete="off"
              placeholder="https://"
              value={value.base_url}
              onChange={set("base_url")}
              onBlur={autoDiscover}
            />
            <span className="text-[11px] text-accent-400">{t("setup.ai.base_url_hint")}</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">{t("setup.ai.api_key")}</span>
            <input
              className="field font-mono text-[13px]"
              type="password"
              autoComplete="off"
              value={value.api_key}
              onChange={set("api_key")}
              onBlur={autoDiscover}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={d.found.busy || (!value.api_key.trim() && !value.base_url.trim())} onClick={() => d.discover(value)}>
              {d.found.busy && <Loader2 size={14} className="animate-spin" />}
              {t("setup.ai.discover")}
            </Button>
            {!d.found.busy && !stale && d.found.models.length > 0 && (
              <span className="text-xs text-accent-500">{t("setup.ai.found_n", { n: options.length })}</span>
            )}
          </div>
        </>
      )}
      {(modelOnly || !stale) && d.found.err && <p className="text-xs text-rose-600">{d.found.err}</p>}
      {modelOnly && d.found.models.length > 0 && options.length === 0 && <p className="text-xs text-amber-700">{t("setup.ai.no_embedding_here")}</p>}
      <label className="flex flex-col gap-1.5">
        <span className="field-label">{t("setup.ai.model")}</span>
        {showSelect ? (
          <select
            className="field text-[13px]"
            value={options.some((m) => m.id === value.model) ? value.model : ""}
            onChange={(e) => (e.target.value === OTHER ? setTyping(true) : onChange({ ...value, model: e.target.value }))}
          >
            <option value="" disabled>
              {t("setup.ai.pick_model")}
            </option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
            <option value={OTHER}>{t("setup.ai.type_model")}</option>
          </select>
        ) : (
          <input
            className="field font-mono text-[13px]"
            autoComplete="off"
            value={value.model}
            onChange={set("model")}
            placeholder={modelOnly && !d.found.models.length ? t("setup.ai.discover_first") : ""}
          />
        )}
      </label>
    </fieldset>
  );
}

function FinishStep() {
  const { t } = useI18n();
  useEffect(() => {
    finishSetup().catch(() => undefined);
  }, []);
  return (
    <Card icon={<CheckCircle2 size={18} />} title={t("setup.finish.title")} desc={t("setup.finish.desc")}>
      <div className="flex flex-wrap justify-end gap-2">
        <Link href="/settings/" className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-medium text-accent-800 shadow-soft ring-1 ring-inset ring-accent-200 hover:ring-brand-300">
          {t("setup.finish.go_settings")}
        </Link>
        <Link href="/" className="inline-flex items-center justify-center rounded-xl bg-brand-600 bg-brand-grad px-4 py-2 text-sm font-medium text-white shadow-brand hover:brightness-105">
          {t("setup.finish.go_first")}
        </Link>
      </div>
    </Card>
  );
}
