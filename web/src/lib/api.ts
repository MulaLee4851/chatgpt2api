import { httpRequest, request } from "@/lib/request";

export type AccountType = string;
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = "gpt-image-2" | "codex-gpt-image-2";
export type GptWebMessageRole = "user" | "assistant" | "system";
export type AuthRole = "admin" | "user";

export type Account = {
  access_token: string;
  type: AccountType;
  status: AccountStatus;
  quota: number;
  image_quota_unknown?: boolean;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restore_at?: string | null;
  success: number;
  fail: number;
  last_used_at?: string | null;
};

type AccountListResponse = {
  items: Account[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  errors: Array<{ access_token: string; error: string }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

type AccountSummaryResponse = {
  normal_count: number;
};

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  global_system_prompt?: string;
  sensitive_words?: string[];
  ai_review?: {
    enabled?: boolean;
    base_url?: string;
    api_key?: string;
    model?: string;
    prompt?: string;
  };
  scheduled_account_refresh?: {
    enabled?: boolean;
    interval_minutes?: number | string;
    worker_count?: number | string;
  };
  refresh_account_interval_minute?: number | string;
  image_retention_days?: number | string;
  image_poll_timeout_secs?: number | string;
  image_account_concurrency?: number | string;
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
  log_levels?: string[];
  backup?: BackupSettings;
  backup_state?: BackupState;
  [key: string]: unknown;
};

export type BackupInclude = {
  config: boolean;
  register: boolean;
  cpa: boolean;
  sub2api: boolean;
  logs: boolean;
  image_tasks: boolean;
  accounts_snapshot: boolean;
  auth_keys_snapshot: boolean;
  images: boolean;
};

export type BackupSettings = {
  enabled: boolean;
  provider: "cloudflare_r2" | string;
  account_id: string;
  access_key_id: string;
  secret_access_key: string;
  bucket: string;
  prefix: string;
  interval_minutes: number | string;
  rotation_keep: number | string;
  encrypt: boolean;
  passphrase: string;
  include: BackupInclude;
};

export type BackupState = {
  running: boolean;
  last_started_at?: string | null;
  last_finished_at?: string | null;
  last_status?: string;
  last_error?: string | null;
  last_object_key?: string | null;
};

export type BackupItem = {
  key: string;
  name: string;
  size: number;
  updated_at?: string | null;
  encrypted: boolean;
};

export type BackupDetail = {
  key: string;
  name: string;
  encrypted: boolean;
  created_at?: string | null;
  trigger?: string | null;
  app_version?: string | null;
  storage_backend?: Record<string, unknown> | null;
  files: Array<{
    name: string;
    exists: boolean;
    content_type?: string;
    size: number;
    sha256?: string;
  }>;
  snapshots: Array<{
    name: string;
    count: number;
  }>;
};

export type ManagedImage = {
  rel: string;
  path?: string;
  name: string;
  date: string;
  size: number;
  url: string;
  thumbnail_url?: string;
  created_at: string;
  width?: number;
  height?: number;
  tags?: string[];
};

export type SystemLog = {
  id: string;
  time: string;
  type: "call" | "account" | string;
  summary?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ImageResponse = {
  created: number;
  data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
};

export type ImageTask = {
  id: string;
  status: "queued" | "running" | "success" | "error";
  mode: "generate" | "edit";
  model?: ImageModel;
  size?: string;
  created_at: string;
  updated_at: string;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: string;
};

export type GptWebChatMessage = {
  role: GptWebMessageRole;
  content: string;
};

export type GptWebSourceItem = {
  id: string;
  title: string;
  url: string;
  attribution?: string | null;
  snippet?: string | null;
  ref_indices?: string[];
};

export type GptWebInlineLink = {
  id: string;
  label: string;
  url: string;
  ref_indices?: string[];
};

export type GptWebSourceGroup = {
  type: "grouped_webpages";
  items: GptWebSourceItem[];
};

export type GptWebChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: GptWebMessageRole;
      content?: string;
    };
    finish_reason?: string | null;
  }>;
  x_gpt_web?: {
    sources?: GptWebSourceGroup[];
    inline_links?: GptWebInlineLink[];
  };
};

type ImageTaskListResponse = {
  items: ImageTask[];
  missing_ids: string[];
};

export type UserKeyPermissions = {
  chat: boolean;
  image: boolean;
};

export type UserKeyLimits = {
  expires_at: string | null;
  max_tokens: number | null;
  max_images: number | null;
};

export type UserKeyUsage = {
  used_tokens: number;
  used_images: number;
};

export type LoginResponse = {
  ok: boolean;
  version: string;
  role: AuthRole;
  subject_id: string;
  name: string;
  permissions: UserKeyPermissions;
  limits: UserKeyLimits;
  usage: UserKeyUsage;
};

export type ImageTemplatePrompts = {
  positive: string;
  negative: string;
};

export type ImageTemplateDefaults = {
  count: number;
  size: string;
};

export type ImageTemplatePlaceholderValidation = {
  min_length?: number | null;
  max_length?: number | null;
  min?: number | null;
  max?: number | null;
  regex?: string;
  options?: string[];
};

export type ImageTemplatePlaceholder = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select";
  default_value: string;
  required: boolean;
  help: string;
  validation: ImageTemplatePlaceholderValidation;
  order?: number;
};

export type ImageTemplateReference = {
  key: string;
  label: string;
  type: "reference" | "original";
  required: boolean;
  weight: number;
  help: string;
  asset_rel: string | null;
  asset_url?: string | null;
  order?: number;
};

export type ImageTemplate = {
  id: string;
  name: string;
  description: string;
  mode: "generate" | "edit";
  prompts: ImageTemplatePrompts;
  defaults: ImageTemplateDefaults;
  placeholders: ImageTemplatePlaceholder[];
  references: ImageTemplateReference[];
  tags: string[];
  status: "active" | "draft" | "archived";
  version: string;
  cover_image_rel: string | null;
  cover_image_url: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  prompt_template: string;
  negative_prompt: string;
  default_count: number;
  default_size: string;
  requires_placeholder: boolean;
  placeholder_token: string;
  requires_user_source_image: boolean;
  reference_image_rel: string | null;
  reference_image_url: string | null;
  original_image_rel: string | null;
  original_image_url: string | null;
  enabled: boolean;
};

export type ImageTemplatePayload = {
  name: string;
  description: string;
  mode: "generate" | "edit";
  prompts: ImageTemplatePrompts;
  defaults: ImageTemplateDefaults;
  placeholders: ImageTemplatePlaceholder[];
  references: ImageTemplateReference[];
  tags: string[];
  status: "active" | "draft" | "archived";
  version: string;
};

function normalizeImageTemplate(input: Partial<ImageTemplate> & Record<string, unknown>): ImageTemplate {
  const promptsSource = (input.prompts as Partial<ImageTemplatePrompts> | undefined) || {};
  const defaultsSource = (input.defaults as Partial<ImageTemplateDefaults> | undefined) || {};
  const placeholdersSource = Array.isArray(input.placeholders) ? input.placeholders : [];
  const referencesSource = Array.isArray(input.references) ? input.references : [];
  const tagsSource = Array.isArray(input.tags) ? input.tags : [];
  const positivePrompt = String(promptsSource.positive ?? input.prompt_template ?? "");
  const negativePrompt = String(promptsSource.negative ?? input.negative_prompt ?? "");
  const references = referencesSource.map((reference, index) => {
    const current = (reference || {}) as Partial<ImageTemplateReference> & Record<string, unknown>;
    return {
      key: String(current.key ?? `reference_${index + 1}`),
      label: String(current.label ?? current.key ?? `参考图 ${index + 1}`),
      type: current.type === "original" ? "original" : "reference",
      required: Boolean(current.required),
      weight: typeof current.weight === "number" ? current.weight : Number(current.weight ?? 1) || 1,
      help: String(current.help ?? ""),
      asset_rel: current.asset_rel == null ? null : String(current.asset_rel),
      asset_url: current.asset_url == null ? null : String(current.asset_url),
      order: typeof current.order === "number" ? current.order : undefined,
    } satisfies ImageTemplateReference;
  });
  const placeholders = placeholdersSource.map((placeholder, index) => {
    const current = (placeholder || {}) as Partial<ImageTemplatePlaceholder> & Record<string, unknown>;
    const validation = (current.validation as Partial<ImageTemplatePlaceholderValidation> | undefined) || {};
    return {
      key: String(current.key ?? `field_${index + 1}`),
      label: String(current.label ?? current.key ?? `变量 ${index + 1}`),
      type: current.type === "textarea" || current.type === "number" || current.type === "select" ? current.type : "text",
      default_value: String(current.default_value ?? ""),
      required: Boolean(current.required),
      help: String(current.help ?? ""),
      validation: {
        min_length: validation.min_length ?? null,
        max_length: validation.max_length ?? null,
        min: validation.min ?? null,
        max: validation.max ?? null,
        regex: String(validation.regex ?? ""),
        options: Array.isArray(validation.options) ? validation.options.map((option) => String(option)) : [],
      },
      order: typeof current.order === "number" ? current.order : undefined,
    } satisfies ImageTemplatePlaceholder;
  });

  return {
    id: String(input.id ?? ""),
    name: String(input.name ?? ""),
    description: String(input.description ?? ""),
    mode: input.mode === "edit" ? "edit" : "generate",
    prompts: {
      positive: positivePrompt,
      negative: negativePrompt,
    },
    defaults: {
      count: typeof defaultsSource.count === "number" ? defaultsSource.count : Number(input.default_count ?? defaultsSource.count ?? 1) || 1,
      size: String(defaultsSource.size ?? input.default_size ?? ""),
    },
    placeholders,
    references,
    tags: tagsSource.map((tag) => String(tag)).filter(Boolean),
    status: input.status === "draft" || input.status === "archived" ? input.status : "active",
    version: String(input.version ?? "1.0.0"),
    cover_image_rel: input.cover_image_rel == null ? null : String(input.cover_image_rel),
    cover_image_url: input.cover_image_url == null ? null : String(input.cover_image_url),
    created_by: input.created_by == null ? null : String(input.created_by),
    updated_by: input.updated_by == null ? null : String(input.updated_by),
    created_at: String(input.created_at ?? ""),
    updated_at: String(input.updated_at ?? ""),
    prompt_template: String(input.prompt_template ?? positivePrompt),
    negative_prompt: String(input.negative_prompt ?? negativePrompt),
    default_count: typeof input.default_count === "number" ? input.default_count : Number(defaultsSource.count ?? 1) || 1,
    default_size: String(input.default_size ?? defaultsSource.size ?? ""),
    requires_placeholder: typeof input.requires_placeholder === "boolean" ? input.requires_placeholder : placeholders.length > 0,
    placeholder_token: String(input.placeholder_token ?? (placeholders[0] ? `{{${placeholders[0].key}}}` : "{{prompt}}")),
    requires_user_source_image:
      typeof input.requires_user_source_image === "boolean"
        ? input.requires_user_source_image
        : references.some((reference) => reference.type === "original" && reference.required && !reference.asset_rel),
    reference_image_rel: input.reference_image_rel == null ? references.find((reference) => reference.type === "reference")?.asset_rel ?? null : String(input.reference_image_rel),
    reference_image_url: input.reference_image_url == null ? references.find((reference) => reference.type === "reference")?.asset_url ?? null : String(input.reference_image_url),
    original_image_rel: input.original_image_rel == null ? references.find((reference) => reference.type === "original")?.asset_rel ?? null : String(input.original_image_rel),
    original_image_url: input.original_image_url == null ? references.find((reference) => reference.type === "original")?.asset_url ?? null : String(input.original_image_url),
    enabled: typeof input.enabled === "boolean" ? input.enabled : input.status !== "archived",
  };
}

function normalizeImageTemplateListResponse(response: { items: Array<Partial<ImageTemplate> & Record<string, unknown>> }) {
  return {
    items: response.items.map((item) => normalizeImageTemplate(item)),
  };
}

function normalizeImageTemplateMutationResponse(response: { item: Partial<ImageTemplate> & Record<string, unknown>; items: Array<Partial<ImageTemplate> & Record<string, unknown>> }) {
  return {
    item: normalizeImageTemplate(response.item),
    items: response.items.map((item) => normalizeImageTemplate(item)),
  };
}

function normalizeSingleImageTemplateResponse(response: { item: Partial<ImageTemplate> & Record<string, unknown> }) {
  return {
    item: normalizeImageTemplate(response.item),
  };
}

export type UserKey = {
  id: string;
  name: string;
  role: "user";
  enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
  permissions: UserKeyPermissions;
  limits: UserKeyLimits;
  usage: UserKeyUsage;
};

export type RegisterConfig = {
  enabled: boolean;
  mail: {
    request_timeout: number;
    wait_timeout: number;
    wait_interval: number;
    providers: Array<Record<string, unknown>>;
  };
  proxy: string;
  total: number;
  threads: number;
  mode: "total" | "quota" | "available";
  target_quota: number;
  target_available: number;
  check_interval: number;
  stats: {
    job_id?: string;
    success: number;
    fail: number;
    done: number;
    running: number;
    threads: number;
    elapsed_seconds?: number;
    avg_seconds?: number;
    success_rate?: number;
    current_quota?: number;
    current_available?: number;
    started_at?: string;
    updated_at?: string;
    finished_at?: string;
  };
  logs?: Array<{
    time: string;
    text: string;
    level: string;
  }>;
};

export async function login(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    redirectOnUnauthorized: false,
  });
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function fetchAccountSummary() {
  return httpRequest<AccountSummaryResponse>("/api/accounts/summary");
}

export async function createAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens },
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
  });
}

export async function refreshAccounts(accessTokens: string[] = []) {
  return httpRequest<AccountRefreshResponse>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
  });
}

export async function generateImage(prompt: string, model?: ImageModel, size?: string) {
  return httpRequest<ImageResponse>(
    "/v1/images/generations",
    {
      method: "POST",
      body: {
        prompt,
        ...(model ? { model } : {}),
        ...(size ? { size } : {}),
        n: 1,
        response_format: "b64_json",
      },
    },
  );
}

export async function editImage(files: File | File[], prompt: string, model?: ImageModel, size?: string) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  formData.append("n", "1");

  return httpRequest<ImageResponse>(
    "/v1/images/edits",
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function createImageGenerationTask(clientTaskId: string, prompt: string, model?: ImageModel, size?: string) {
  return httpRequest<ImageTask>("/api/image-tasks/generations", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      prompt,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
    },
  });
}

export async function createImageEditTask(
  clientTaskId: string,
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("client_task_id", clientTaskId);
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }

  return httpRequest<ImageTask>("/api/image-tasks/edits", {
    method: "POST",
    body: formData,
  });
}

export async function fetchImageTasks(ids: string[]) {
  const params = new URLSearchParams();
  if (ids.length > 0) {
    params.set("ids", ids.join(","));
  }
  return httpRequest<ImageTaskListResponse>(`/api/image-tasks${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function fetchImageTemplates() {
  const response = await httpRequest<{ items: Array<Partial<ImageTemplate> & Record<string, unknown>> }>("/api/image-templates");
  return normalizeImageTemplateListResponse(response);
}

export async function createImageTemplate(body: ImageTemplatePayload) {
  const response = await httpRequest<{ item: Partial<ImageTemplate> & Record<string, unknown>; items: Array<Partial<ImageTemplate> & Record<string, unknown>> }>("/api/image-templates", {
    method: "POST",
    body,
  });
  return normalizeImageTemplateMutationResponse(response);
}

export async function updateImageTemplate(templateId: string, body: ImageTemplatePayload) {
  const response = await httpRequest<{ item: Partial<ImageTemplate> & Record<string, unknown>; items: Array<Partial<ImageTemplate> & Record<string, unknown>> }>(`/api/image-templates/${templateId}`, {
    method: "POST",
    body,
  });
  return normalizeImageTemplateMutationResponse(response);
}

export async function deleteImageTemplate(templateId: string) {
  const response = await httpRequest<{ items: Array<Partial<ImageTemplate> & Record<string, unknown>> }>(`/api/image-templates/${templateId}`, {
    method: "DELETE",
  });
  return normalizeImageTemplateListResponse(response);
}

export async function uploadImageTemplateAsset(templateId: string, kind: "reference" | "original" | "cover", file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await httpRequest<{ item: Partial<ImageTemplate> & Record<string, unknown> }>(`/api/image-templates/${templateId}/assets/${kind}`, {
    method: "POST",
    body: formData,
  });
  return normalizeSingleImageTemplateResponse(response);
}

export async function deleteImageTemplateAsset(templateId: string, kind: "reference" | "original" | "cover") {
  const response = await httpRequest<{ item: Partial<ImageTemplate> & Record<string, unknown> }>(`/api/image-templates/${templateId}/assets/${kind}`, {
    method: "DELETE",
  });
  return normalizeSingleImageTemplateResponse(response);
}

export async function uploadImageTemplateReferenceAsset(templateId: string, referenceKey: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await httpRequest<{ item: Partial<ImageTemplate> & Record<string, unknown> }>(`/api/image-templates/${templateId}/references/${encodeURIComponent(referenceKey)}/asset`, {
    method: "POST",
    body: formData,
  });
  return normalizeSingleImageTemplateResponse(response);
}

export async function deleteImageTemplateReferenceAsset(templateId: string, referenceKey: string) {
  const response = await httpRequest<{ item: Partial<ImageTemplate> & Record<string, unknown> }>(`/api/image-templates/${templateId}/references/${encodeURIComponent(referenceKey)}/asset`, {
    method: "DELETE",
  });
  return normalizeSingleImageTemplateResponse(response);
}

export async function createGptWebChatCompletion(messages: GptWebChatMessage[]) {
  return httpRequest<GptWebChatCompletionResponse>("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gpt-web",
      messages,
      stream: false,
    },
  });
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

export async function testBackupConnection() {
  return httpRequest<{ result: { ok: boolean; status: number } }>("/api/backup/test", {
    method: "POST",
    body: {},
  });
}

export async function fetchBackups() {
  return httpRequest<{ items: BackupItem[]; state: BackupState; settings: BackupSettings }>("/api/backups");
}

export async function runBackupNow() {
  return httpRequest<{ result: { key: string; size: number; encrypted: boolean } }>("/api/backups/run", {
    method: "POST",
    body: {},
  });
}

export async function deleteBackup(key: string) {
  return httpRequest<{ ok: boolean }>("/api/backups/delete", {
    method: "POST",
    body: { key },
  });
}

export async function fetchBackupDetail(key: string) {
  const params = new URLSearchParams();
  params.set("key", key);
  return httpRequest<{ item: BackupDetail }>(`/api/backups/detail?${params.toString()}`);
}

export function getBackupDownloadUrl(key: string) {
  const params = new URLSearchParams();
  params.set("key", key);
  return `/api/backups/download?${params.toString()}`;
}

export async function fetchManagedImages(filters: { start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: ManagedImage[]; groups: Array<{ date: string; items: ManagedImage[] }> }>(
    `/api/images${params.toString() ? `?${params.toString()}` : ""}`,
  );
}

export async function deleteManagedImages(body: { paths?: string[]; start_date?: string; end_date?: string; all_matching?: boolean }) {
  return httpRequest<{ removed: number }>("/api/images/delete", { method: "POST", body });
}

export async function downloadImages(paths: string[]) {
  const response = await request.post("/api/images/download", { paths }, { responseType: "blob" });
  const blob = response.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "images.zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadSingleImage(path: string) {
  const response = await request.get(`/api/images/download/${path}`, { responseType: "blob" });
  const blob = response.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || "image.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function fetchImageTags() {
  return httpRequest<{ tags: string[] }>("/api/images/tags");
}

export async function setImageTags(path: string, tags: string[]) {
  return httpRequest<{ ok: boolean; tags: string[] }>("/api/images/tags", {
    method: "POST",
    body: { path, tags },
  });
}

export async function deleteImageTag(tag: string) {
  return httpRequest<{ ok: boolean; removed_from: number }>(`/api/images/tags/${encodeURIComponent(tag)}`, {
    method: "DELETE",
  });
}

export async function fetchSystemLogs(filters: { type?: string; start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: SystemLog[] }>(`/api/logs${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function deleteSystemLogs(ids: string[]) {
  return httpRequest<{ removed: number }>("/api/logs/delete", {
    method: "POST",
    body: { ids },
  });
}

export async function fetchUserKeys() {
  return httpRequest<{ items: UserKey[] }>("/api/auth/users");
}

export async function createUserKey(body: {
  name: string;
  permissions: UserKeyPermissions;
  limits: UserKeyLimits;
}) {
  return httpRequest<{ item: UserKey; key: string; items: UserKey[] }>("/api/auth/users", {
    method: "POST",
    body,
  });
}

export async function updateUserKey(
  keyId: string,
  updates: {
    enabled?: boolean;
    name?: string;
    key?: string;
    permissions?: UserKeyPermissions;
    limits?: UserKeyLimits;
  },
) {
  return httpRequest<{ item: UserKey; items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteUserKey(keyId: string) {
  return httpRequest<{ items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "DELETE",
  });
}

export async function fetchRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register");
}

export async function updateRegisterConfig(updates: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register", {
    method: "POST",
    body: updates,
  });
}

export async function startRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/start", { method: "POST" });
}

export async function stopRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/stop", { method: "POST" });
}

export async function resetRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/reset", { method: "POST" });
}

// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  import_job?: CPAImportJob | null;
};

export type CPARemoteFile = {
  name: string;
  email: string;
};

export type CPAImportJob = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  added: number;
  skipped: number;
  refreshed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
};

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools");
}

export async function createCPAPool(pool: { name: string; base_url: string; secret_key: string }) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function fetchCPAPoolFiles(poolId: string) {
  return httpRequest<{ pool_id: string; files: CPARemoteFile[] }>(`/api/cpa/pools/${poolId}/files`);
}

export async function startCPAImport(poolId: string, names: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`, {
    method: "POST",
    body: { names },
  });
}

export async function fetchCPAPoolImportJob(poolId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`);
}

// ── Sub2API ────────────────────────────────────────────────────────

export type Sub2APIServer = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  has_api_key: boolean;
  group_id: string;
  import_job?: CPAImportJob | null;
};

export type Sub2APIRemoteAccount = {
  id: string;
  name: string;
  email: string;
  plan_type: string;
  status: string;
  expires_at: string;
  has_refresh_token: boolean;
};

export type Sub2APIRemoteGroup = {
  id: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  account_count: number;
  active_account_count: number;
};

export async function fetchSub2APIServers() {
  return httpRequest<{ servers: Sub2APIServer[] }>("/api/sub2api/servers");
}

export async function createSub2APIServer(server: {
  name: string;
  base_url: string;
  email: string;
  password: string;
  api_key: string;
  group_id: string;
}) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>("/api/sub2api/servers", {
    method: "POST",
    body: server,
  });
}

export async function updateSub2APIServer(
  serverId: string,
  updates: {
    name?: string;
    base_url?: string;
    email?: string;
    password?: string;
    api_key?: string;
    group_id?: string;
  },
) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "POST",
    body: updates,
  });
}

export async function fetchSub2APIServerGroups(serverId: string) {
  return httpRequest<{ server_id: string; groups: Sub2APIRemoteGroup[] }>(
    `/api/sub2api/servers/${serverId}/groups`,
  );
}

export async function deleteSub2APIServer(serverId: string) {
  return httpRequest<{ servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "DELETE",
  });
}

export async function fetchSub2APIServerAccounts(serverId: string) {
  return httpRequest<{ server_id: string; accounts: Sub2APIRemoteAccount[] }>(
    `/api/sub2api/servers/${serverId}/accounts`,
  );
}

export async function startSub2APIImport(serverId: string, accountIds: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`, {
    method: "POST",
    body: { account_ids: accountIds },
  });
}

export async function fetchSub2APIImportJob(serverId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`);
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}
