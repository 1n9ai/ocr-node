export type VectorType = "local" | "qdrant" | "pgvector" | "pinecone";
export type SecretMask = { set: boolean; hint: string };
export type ModelRole = "llm" | "embedding" | "rerank";
export type ProtocolId = "openai_compatible" | "google" | "ollama";

export interface ProtocolInfo {
  label: string;
}

export interface ProviderConn {
  id: string;
  name: string;
  type: ProtocolId;
  base_url: string;
  api_key: SecretMask;
  configured: boolean;
}

export interface RegistryModel {
  id: string;
  name: string;
  kind: ModelRole;
  provider: string;
  provider_name: string;
  model: string;
  dim?: number;
  params?: Record<string, unknown>;
  is_default: boolean;
  used_by: { jobs: string[] };
}

export type NotifyRecipient = { rid: string; name: string; hint: string; kind: "user" | "group" };

export interface NodeSettings {
  providers: ProviderConn[];
  models: RegistryModel[];
  defaults: Record<ModelRole, string | null>;
  vector: { type?: VectorType; url: string; api_key: SecretMask; tunnel?: { status: string; error?: string | null } | null };
  central: { url: string; license_key: SecretMask };
  notify: { enabled: boolean; recipients: NotifyRecipient[]; template: string; api_key: SecretMask };
}

export type ProviderModel = { id: string; kinds: string[] };

export type CheckItem = {
  ok?: boolean | null;
  message?: string;
  error_code?: string;
  code?: string;
  dim?: number;
  latency_ms?: number;
  reasoning_tokens?: number;
  [key: string]: unknown;
};

export interface LicenseInfo extends CheckItem {
  status?: string;
  valid_until?: string | null;
  plan?: string;
  displaced?: boolean;
  warnings?: { code: string; message: string }[];
}

export interface CheckResult {
  central?: CheckItem & { url?: string };
  license?: LicenseInfo;
  llm?: CheckItem;
  embedding?: CheckItem;
  vector?: CheckItem;
  rerank?: CheckItem;
}

export interface AdminStatus {
  central: CheckItem & { url: string };
  license: LicenseInfo;
  counts: { docs: number; rules: number };
}

// ── OCR ──

export type DocStatus = "pending_review" | "approved" | "failed";
export type DocCounts = Record<DocStatus, number>;

export interface OcrField {
  label: string;
  value: string;
  confidence: number;
}

export interface OcrIssue {
  code: "missing_field" | "low_confidence" | "unreadable";
  label?: string;
  confidence?: number;
}

export interface OcrCheck {
  ok: boolean;
  issues: OcrIssue[];
}

export interface OcrDocSummary {
  id: string;
  filename: string;
  size: number;
  rule_id: string;
  document_type: string;
  fields: OcrField[];
  overall_confidence: number;
  parse_error: boolean;
  status: DocStatus;
  check: OcrCheck;
  created_at: string;
  approved_at: string | null;
  approved_by: "auto" | "user" | null;
  notified: "sent" | "partial" | "failed" | null;
}

export interface OcrDoc extends OcrDocSummary {
  raw_text: string;
}

export interface OcrRule {
  id: string;
  name: string;
  required_labels: string[];
  min_confidence: number;
  auto_approve: boolean;
}

export type BillingPrice = { amount: number; currency: string };

export interface BillingStatus {
  enabled: boolean;
  message?: string;
  license_type?: string;
  billing_status?: string | null;
  plan?: string;
  has_subscription?: boolean;
  subscription_live?: boolean;
  prices?: Partial<Record<"month" | "year", BillingPrice>>;
}
