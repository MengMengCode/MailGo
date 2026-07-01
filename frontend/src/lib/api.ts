const API_BASE = "/api/v1";
export const AUTH_UNAUTHORIZED_EVENT = "mailgo:auth-unauthorized";

export async function apiFetch(
  input: RequestInfo | URL,
  options: RequestInit = {},
): Promise<Response> {
  const res = await fetch(input, {
    ...options,
    credentials: "same-origin",
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
  }
  return res;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const res = await apiFetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: "Request failed" }))) as {
      error?: string;
    };
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export const authApi = {
  login: (password: string) =>
    request<{ expires_at: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  session: () => request<{ authenticated: boolean }>("/auth/session"),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) =>
    request<{ message: string }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password, new_password }),
    }),
};

/* ==========================================================================
   Accounts
   ========================================================================== */

export interface Account {
  id: number;
  name: string;
  email: string;
  provider: string;
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_encryption: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  smtp_encryption: string;
  username: string;
  sender_email: string;
  avatar_url: string;
  auto_reply_enabled: boolean;
  auto_reply_subject: string;
  auto_reply_body: string;
  proxy_enabled: boolean;
  proxy_host: string;
  proxy_port: number;
  is_default: boolean;
  tag_color: string;
  sync_days: number;
  sync_max_messages: number;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountCreateRequest {
  name: string;
  email: string;
  provider: string;
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_encryption?: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  smtp_encryption?: string;
  username: string;
  password: string;
  oauth_flow_id?: string;
  sender_email?: string;
  avatar_url?: string;
  auto_reply_enabled?: boolean;
  auto_reply_subject?: string;
  auto_reply_body?: string;
  proxy_enabled?: boolean;
  proxy_host?: string;
  proxy_port?: number;
  tag_color?: string;
  sync_days?: number;
  sync_max_messages?: number;
}

export interface ProviderConfig {
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_encryption: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  smtp_encryption: string;
}

export interface DetectResponse {
  found: boolean;
  method: string;
  provider: ProviderConfig;
  mx_records: string[];
  imap_ok: boolean;
  smtp_ok: boolean;
  error_message?: string;
  auth_type?: "microsoft_oauth";
  oauth_configured: boolean;
}

export interface ProbeRequest {
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_encryption?: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  smtp_encryption?: string;
}

export interface ProbeResponse {
  ok: boolean;
  imap_ok: boolean;
  smtp_ok: boolean;
  error_message?: string;
}

export interface VerifyRequest {
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_encryption?: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  smtp_encryption?: string;
  username: string;
  password: string;
}

export interface VerifyResponse {
  ok: boolean;
  imap_ok: boolean;
  smtp_ok: boolean;
  error_message?: string;
}

export interface Attachment {
  id: number;
  message_id: number;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string;
  part_id: string;
}

export interface AttachmentInput {
  filename: string;
  mime_type: string;
  size: number;
  content_id?: string;
  data_base64: string;
}

export const accountsApi = {
  list: () => request<Account[]>("/accounts"),
  get: (id: number) => request<Account>(`/accounts/${id}`),
  create: (data: AccountCreateRequest) =>
    request<{ id: number }>("/accounts", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: Partial<AccountCreateRequest>) =>
    request<{ message: string }>(`/accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  delete: (id: number) =>
    request<{ message: string }>(`/accounts/${id}`, { method: "DELETE" }),
  detect: (email: string) =>
    request<DetectResponse>("/accounts/detect", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  probe: (data: ProbeRequest) =>
    request<ProbeResponse>("/accounts/probe", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  verify: (data: VerifyRequest) =>
    request<VerifyResponse>("/accounts/verify", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  startMicrosoftDeviceAuth: (email: string) =>
    request<MicrosoftDeviceAuthorization>("/accounts/microsoft/device/start", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  pollMicrosoftDeviceAuth: (flowId: string) =>
    request<MicrosoftDevicePoll>("/accounts/microsoft/device/poll", {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId }),
    }),
};

export interface MicrosoftDeviceAuthorization {
  flow_id: string;
  user_code: string;
  verification_uri: string;
  message: string;
  expires_in: number;
  interval: number;
}

export interface MicrosoftDevicePoll {
  status: "pending" | "authorized";
  interval?: number;
}

export interface AttachmentPreviewData {
  filename: string;
  mime_type: string;
  size: number;
  data_base64: string;
}

export const attachmentsApi = {
  list: (messageId: number) =>
    request<Attachment[]>(`/messages/${messageId}/attachments`),
  url: (attachmentId: number) => `/api/v1/attachments/${attachmentId}`,
  /** Fetch attachment bytes as base64-wrapped JSON. Used for previewing PDFs
   *  without triggering download-manager hijacking (response is JSON, not
   *  application/pdf). */
  previewData: (attachmentId: number) =>
    request<AttachmentPreviewData>(`/attachments/${attachmentId}/preview-data`),
};

/* ==========================================================================
   Folders
   ========================================================================== */

export type FolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "archive"
  | "spam"
  | "starred"
  | "important"
  | "all"
  | string;

export interface Folder {
  id: number;
  account_id: number;
  name: string;
  role: FolderRole;
  uid_validity: number | null;
  uid_next: number | null;
  last_synced_at: string | null;
  created_at: string;
  unread_count: number;
  total_count: number;
}

export const foldersApi = {
  list: (accountId?: number | null) => {
    const qs = accountId ? `?account_id=${accountId}` : "";
    return request<Folder[]>(`/folders${qs}`);
  },
  get: (id: number) => request<Folder>(`/folders/${id}`),
};

/* ==========================================================================
   Messages
   ========================================================================== */

export interface MessageAddress {
  name?: string;
  address: string;
}

export interface Message {
  id: number;
  account_id: number;
  folder_id: number;
  uid: number;
  message_id: string;
  subject: string;
  from_address: string;
  from_name: string;
  to_addresses: string; // JSON-encoded MessageAddress[]
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string;
  body_text: string;
  body_html: string;
  snippet: string;
  received_at: string;
  sent_at: string;
  size: number;
  is_read: boolean;
  is_starred: boolean;
  is_answered: boolean;
  is_forwarded: boolean;
  is_draft: boolean;
  is_deleted: boolean;
  has_attachments: boolean;
  labels: string;
  thread_id: string;
  in_reply_to: string;
  references: string;
  created_at: string;
  updated_at: string;
  folder_name?: string;
}

export interface MessageListResponse {
  messages: Message[];
  total: number;
  page: number;
  page_size: number;
  unread_count: number;
}

export interface MessageThreadResponse {
  messages: Message[];
  total: number;
}

export interface MessageListParams {
  folder_id?: number;
  folder?: string;
  folder_role?: string;
  account_id?: number;
  starred?: boolean;
  unread?: boolean;
  q?: string;
  page?: number;
  page_size?: number;
  include_drafts?: boolean;
  exclude_spam_trash?: boolean;
  has_attachment?: boolean;
  from?: string;
  subject?: string;
  after?: string;
  before?: string;
}

export const messagesApi = {
  list: (params?: MessageListParams) => {
    const search: Record<string, string> = {};
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") {
          search[k] = String(v);
        }
      });
    }
    const qs = Object.keys(search).length
      ? "?" + new URLSearchParams(search).toString()
      : "";
    return request<MessageListResponse>(`/messages${qs}`);
  },
  get: (id: number) => request<Message>(`/messages/${id}`),
  thread: (id: number) => request<MessageThreadResponse>(`/messages/${id}/thread`),
  /** Fetch the full RFC822 source of a message (headers + raw body). */
  raw: (id: number) =>
    apiFetch(`${API_BASE}/messages/${id}/raw`).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    }),
  update: (id: number, data: Partial<Message>) =>
    request<{ message: string }>(`/messages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: number) =>
    request<{ message: string }>(`/messages/${id}`, { method: "DELETE" }),
  restore: (id: number) =>
    request<{ message: string }>(`/messages/${id}/restore`, { method: "POST" }),
  permanentDelete: (id: number) =>
    request<{ message: string }>(`/messages/${id}/permanent-delete`, { method: "POST" }),
  star: (id: number) =>
    request<{ message: string }>(`/messages/${id}/star`, { method: "POST" }),
  toggleRead: (id: number) =>
    request<{ message: string }>(`/messages/${id}/toggle-read`, {
      method: "POST",
    }),
  move: (id: number, folderId: number) =>
    request<{ message: string }>(`/messages/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ folder_id: folderId }),
    }),
  batch: (
    action:
      | "archive"
      | "delete"
      | "restore"
      | "permanent_delete"
      | "mark_read"
      | "mark_unread"
      | "star"
      | "unstar",
    ids: number[],
  ) =>
    request<{ count: number }>(`/messages/batch`, {
      method: "POST",
      body: JSON.stringify({ action, ids }),
    }),
  send: (data: {
    account_id: number;
    to_addresses: string[];
    cc_addresses?: string[];
    bcc_addresses?: string[];
    subject: string;
    body_html: string;
    body_text: string;
    in_reply_to?: string;
    references?: string;
    attachments?: AttachmentInput[];
  }) =>
    request<{ id: number }>(`/messages/send`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

/* ==========================================================================
   Settings
   ========================================================================== */

export interface Setting {
  id: number;
  key: string;
  value: string;
  updated_at: string;
}

/** Appearance customization settings stored as a JSON blob under key "appearance". */
export interface AppearanceSettings {
  accent_color: string;
  accent_saturation: number;
  sidebar_blur: number;
  sidebar_opacity: number;
  bg_blur: number;
  border_radius: number;
  font_size: "sm" | "md" | "lg";
  compact_mode: boolean;
  shadow_intensity: "none" | "sm" | "md" | "lg";
  animation_speed: "off" | "slow" | "normal" | "fast";
  bg_image: string;
  bg_image_mobile: string;
  bg_opacity: number;
  text_color_light: string;
  text_color_dark: string;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  accent_color: "#006bff",
  accent_saturation: 100,
  sidebar_blur: 0,
  sidebar_opacity: 100,
  bg_blur: 0,
  border_radius: 6,
  font_size: "md",
  compact_mode: false,
  shadow_intensity: "md",
  animation_speed: "normal",
  bg_image: "",
  bg_image_mobile: "",
  bg_opacity: 100,
  text_color_light: "",
  text_color_dark: "",
};

export const settingsApi = {
  list: () => {
    try {
      localStorage.removeItem("mailgo-setting:ai_api_key");
    } catch {
      /* ignore */
    }
    return request<Setting[]>("/settings");
  },
  update: (key: string, value: string) => {
    // Mirror the value to localStorage so `useAutoRefresh` can pick it up
    // without re-querying the backend on every tick. The `storage` event
    // is also fired in the same tab via a custom event (browsers only fire
    // `storage` on *other* tabs by default).
    try {
      if (key === "ai_api_key" || key === "microsoft_client_secret") {
        localStorage.removeItem(`mailgo-setting:${key}`);
      } else {
        localStorage.setItem(`mailgo-setting:${key}`, String(value));
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: `mailgo-setting:${key}`,
            newValue: String(value),
          }),
        );
      }
    } catch {
      /* ignore — private mode */
    }
    return request<{ message: string }>(`/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },
};

export interface StorageStats {
  messages_bytes: number;
  attachments_bytes: number;
  images_bytes: number;
  total_bytes: number;
  limit_bytes: number;
}

export const storageApi = {
  stats: () => request<StorageStats>("/storage/stats"),
  clear: (type: "messages" | "attachments" | "images" | "all") =>
    request<{ cleared: string; affected: number }>("/storage/clear", {
      method: "POST",
      body: JSON.stringify({ type }),
    }),
};

export interface PGPKey {
  id: number;
  name: string;
  public_key: string;
  private_key?: string;
  created_at: string;
}

export const pgpKeysApi = {
  list: () => request<PGPKey[]>("/pgp-keys"),
  create: (data: { name: string; public_key: string; private_key: string }) =>
    request<{ id: number }>("/pgp-keys", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  delete: (id: number) =>
    request<{ message: string }>(`/pgp-keys/${id}`, { method: "DELETE" }),
  getPrivateKey: (id: number) =>
    request<{ private_key: string }>(`/pgp-keys/${id}/private`),
};

export interface AIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  context_summary?: string;
}

export const aiApi = {
  chat: (data: { messages: AIChatMessage[]; stream?: boolean; model?: string }) =>
    apiFetch(`${API_BASE}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  agent: (data: { messages: AIChatMessage[]; model?: string }) =>
    request<{ message: string }>("/ai/agent", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** Streaming agent — returns raw fetch Response for SSE consumption.
   *  The backend runs tool-calling iterations normally, then streams the
   *  final text response token-by-token via SSE. */
  agentStream: (data: { messages: AIChatMessage[]; model?: string }) =>
    apiFetch(`${API_BASE}/ai/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, stream: true }),
    }),
  title: (data: { prompt: string; response?: string; model?: string }) =>
    request<{ title: string }>("/ai/title", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** Translation endpoint — uses dedicated translation AI settings (or falls
   *  back to the global AI config when `ai_translate_use_global` is true). */
  translate: (data: { messages: AIChatMessage[]; model?: string }) =>
    apiFetch(`${API_BASE}/ai/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
};

/* ==========================================================================
   Drafts
   ========================================================================== */

export interface Draft {
  id: number;
  /** Nullable: a draft can be created without picking an account yet. */
  account_id: number | null;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  subject: string;
  body_html: string;
  body_text: string;
  in_reply_to: string;
  references: string;
  is_trashed: boolean;
  created_at: string;
  updated_at: string;
}

export const draftsApi = {
  list: (trashed = false) =>
    request<Draft[]>(`/drafts${trashed ? "?trashed=true" : ""}`),
  get: (id: number) => request<Draft>(`/drafts/${id}`),
  create: (data: Partial<Draft>) =>
    request<{ id: number }>("/drafts", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: Partial<Draft>) =>
    request<{ message: string }>(`/drafts/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  delete: (id: number) =>
    request<{ message: string }>(`/drafts/${id}`, { method: "DELETE" }),
  restore: (id: number) =>
    request<{ message: string }>(`/drafts/${id}/restore`, { method: "POST" }),
  permanentDelete: (id: number) =>
    request<{ message: string }>(`/drafts/${id}/permanent-delete`, { method: "POST" }),
};

/* ==========================================================================
   Sync (auto-refresh)
   ========================================================================== */

export interface SyncResult {
  ok: boolean;
  synced_accounts: number;
  new_messages: number;
  last_sync_at: string;
  message: string;
}

export interface SyncOptions {
  include_history?: boolean;
  include_attachments?: boolean;
}

export interface SyncStatus {
  syncing: boolean;
  last_sync_at: string | null;
}

export interface SyncProgress {
  status: string;
  started_at?: string;
  updated_at?: string;
  folder?: string;
  folder_synced?: string;
  folder_total?: string;
  synced_folders?: string;
  new_messages?: string;
  error?: string;
}

/** Per-account progress as returned by GET /sync/progress (list-all). */
export interface SyncProgressEntry extends SyncProgress {
  _account_id: string;
}

export const syncApi = {
  trigger: (accountId?: number, options?: SyncOptions) =>
    request<SyncResult>("/sync", {
      method: "POST",
      body: JSON.stringify({
        ...(accountId ? { account_id: accountId } : {}),
        ...(options ?? {}),
      }),
    }),
  status: () => request<SyncStatus>("/sync/status"),
  progress: (accountId?: number) =>
    request<SyncProgress>(
      `/sync/progress${accountId ? `?account_id=${accountId}` : ""}`,
    ),
  /** Fetch per-account progress for ALL accounts (returns an array). */
  progressAll: () => request<SyncProgressEntry[]>("/sync/progress"),
};

export const healthApi = {
  ping: () =>
    apiFetch(`${API_BASE}/health`, { method: "GET" }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
};
