import type {
  AdminStatus,
  BillingStatus,
  CheckItem,
  CheckResult,
  DocCounts,
  ModelRole,
  NodeSettings,
  NotifyRecipient,
  OcrDoc,
  OcrDocSummary,
  OcrField,
  OcrRule,
  ProtocolId,
  ProtocolInfo,
  ProviderModel,
} from "./types";

// หน้าเว็บถูกเสิร์ฟจากเครื่องเดียวกับ API (origin เดียวกัน) — ใช้ path แบบ relative
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

/** error จากเซิร์ฟเวอร์: code ให้หน้าเว็บแปลตามภาษา, message = ข้อความสำรอง (อังกฤษ) */
export class ApiError extends Error {
  code: string;
  params: Record<string, unknown>;
  status: number;

  constructor(status: number, code: string, message: string, params: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    const d = body?.detail;
    if (d && typeof d === "object") return new ApiError(res.status, d.code || "unknown", d.message || "", d.params || {});
    if (body?.error?.code) return new ApiError(res.status, body.error.code, body.error.message || "");
    return new ApiError(res.status, "unknown", typeof d === "string" ? d : "");
  } catch {
    return new ApiError(res.status, "unknown", "");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    const e = await toApiError(res);
    // session ended (or never started): go to the sign-in page and come back here afterwards
    if (e.code === "login_required" && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.replace(`/login/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    throw e;
  }
  return res.json();
}

const json = (body: unknown) => JSON.stringify(body);

// ── เอกสาร OCR ──

export const listDocs = () => request<{ docs: OcrDocSummary[]; counts: DocCounts }>("/api/docs");
export const getDoc = (id: string) => request<OcrDoc>(`/api/docs/${encodeURIComponent(id)}`);
export async function uploadDoc(file: File, ruleId: string): Promise<OcrDoc> {
  const form = new FormData();
  form.append("file", file);
  form.append("rule_id", ruleId);
  return request("/api/docs", { method: "POST", body: form });
}
export const saveDoc = (id: string, fields: OcrField[], approve: boolean) =>
  request<OcrDoc>(`/api/docs/${encodeURIComponent(id)}`, { method: "PUT", body: json({ fields, approve }) });
export const deleteDoc = (id: string) => request<{ ok: true }>(`/api/docs/${encodeURIComponent(id)}`, { method: "DELETE" });
export const exportUrl = () => `${API_BASE}/api/docs/export.csv`;

// ── กฎตรวจ ──

type RuleInput = { name: string; required_labels: string[]; min_confidence: number; auto_approve: boolean };
export const listRules = () => request<{ rules: OcrRule[] }>("/api/rules");
export const createRule = (body: RuleInput) => request<OcrRule>("/api/rules", { method: "POST", body: json(body) });
export const updateRule = (id: string, body: RuleInput) => request<OcrRule>(`/api/rules/${encodeURIComponent(id)}`, { method: "PUT", body: json(body) });
export const deleteRule = (id: string) => request<{ ok: true }>(`/api/rules/${encodeURIComponent(id)}`, { method: "DELETE" });

// ── ตั้งค่า ──

type Primitive = string | number | boolean | null | undefined;
export type SettingsInput = { vector?: Record<string, Primitive>; central?: Record<string, Primitive>; notify?: Record<string, Primitive> };
export type ModelInput = { name: string; kind: ModelRole; provider: string; model: string; dim?: number; make_default?: boolean; params?: string };

export const getSettings = () => request<{ settings: NodeSettings; protocols: Record<ProtocolId, ProtocolInfo> }>("/api/admin/settings");
export const saveSettings = (settings: SettingsInput) =>
  request<{ settings: NodeSettings }>("/api/admin/settings", { method: "PUT", body: json({ settings }) });

export const createProvider = (body: { name: string; base_url: string; api_key: string | null }) =>
  request<{ id: string }>("/api/admin/providers", { method: "POST", body: json(body) });
export const updateProvider = (id: string, body: { name: string; base_url: string; api_key: string | null }) =>
  request<{ id: string }>(`/api/admin/providers/${encodeURIComponent(id)}`, { method: "PUT", body: json(body) });
export const deleteProvider = (id: string) => request<{ ok: true }>(`/api/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
export const testProvider = (body: { id?: string; name: string; base_url: string; api_key: string | null }) =>
  request<{ models: ProviderModel[] }>("/api/admin/providers/test", { method: "POST", body: json(body) });
export const listProviderModels = (id: string) =>
  request<{ models: ProviderModel[] }>(`/api/admin/providers/${encodeURIComponent(id)}/models`, { method: "POST" });

export const createModel = (body: ModelInput) => request<{ id: string }>("/api/admin/models", { method: "POST", body: json(body) });
export const updateModel = (id: string, body: ModelInput) =>
  request<{ id: string }>(`/api/admin/models/${encodeURIComponent(id)}`, { method: "PUT", body: json(body) });
export const deleteModel = (id: string) => request<{ ok: true }>(`/api/admin/models/${encodeURIComponent(id)}`, { method: "DELETE" });
export const setDefaultModel = (id: string) => request<{ ok: true }>(`/api/admin/models/${encodeURIComponent(id)}/default`, { method: "POST" });
export const testModel = (body: { kind: ModelRole; provider: string; model: string; params?: string }) =>
  request<CheckItem>("/api/admin/models/test", { method: "POST", body: json(body) });

export const testNotify = (body: { api_key?: string; rid?: string; text: string }) =>
  request<{ ok: true; sent: number; failed: number }>("/api/admin/notify/test", { method: "POST", body: json(body) });
export const addNotifyRecipient = (body: { id: string; name: string }) =>
  request<{ recipients: NotifyRecipient[] }>("/api/admin/notify/recipients", { method: "POST", body: json(body) });
export const removeNotifyRecipient = (rid: string) =>
  request<{ recipients: NotifyRecipient[] }>(`/api/admin/notify/recipients/${encodeURIComponent(rid)}`, { method: "DELETE" });

export const runFullCheck = () => request<CheckResult>("/api/admin/check", { method: "POST" });
export const getAdminStatus = () => request<AdminStatus>("/api/admin/status");
export const claimLicense = () => request<{ ok: boolean }>("/api/admin/license/claim", { method: "POST" });

// ── แพ็กเกจ (Stripe อยู่ที่ central) ──

export const getBillingStatus = () => request<BillingStatus>("/api/admin/billing");
export const startCheckout = (interval: "month" | "year", returnUrl: string) =>
  request<{ url: string }>("/api/admin/billing/checkout", { method: "POST", body: json({ interval, return_url: returnUrl }) });
export const openBillingPortal = (returnUrl: string) =>
  request<{ url: string }>("/api/admin/billing/portal", { method: "POST", body: json({ return_url: returnUrl }) });

// ── ตั้งค่าครั้งแรก (license → AI) ──
export type SetupStatus = {
  needs_setup: boolean;
  has_license: boolean;
  has_llm: boolean;
  has_password: boolean;
  password_from_env?: boolean;
  admin_user?: string;
  central_url: string;
  program?: { beta: boolean; signup_open: boolean; trial_hours?: number } | null;
};
export type SetupEndpoint = { base_url: string; api_key: string; model: string };
export type DiscoveredModel = { id: string; kinds: string[] };

export const getSetup = () => request<SetupStatus>("/api/admin/setup");
export const startTrial = (email: string) =>
  request<SetupStatus>("/api/admin/setup/demo", { method: "POST", body: json({ email }) });
export const saveLicenseKey = (license_key: string) =>
  request<SetupStatus>("/api/admin/setup/license", { method: "POST", body: json({ license_key }) });
export const discoverModels = (body: { base_url: string; api_key: string }) =>
  request<{ type: string; models: DiscoveredModel[] }>("/api/admin/setup/discover", { method: "POST", body: json(body) });
export const setupAi = (body: { llm: SetupEndpoint }) =>
  request<SetupStatus>("/api/admin/setup/ai", { method: "POST", body: json(body) });
export const finishSetup = () => request<SetupStatus>("/api/admin/setup/finish", { method: "POST" });

// ── sign-in ──
export type AuthMe = { auth_required: boolean; authenticated: boolean; user: string | null };
export const getMe = () => request<AuthMe>("/api/auth/me");
export const login = (username: string, password: string) =>
  request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
export const logout = () => request<{ ok: true }>("/api/auth/logout", { method: "POST" });
export const setupPassword = (password: string) =>
  request<SetupStatus>("/api/admin/setup/password", { method: "POST", body: JSON.stringify({ password }) });
