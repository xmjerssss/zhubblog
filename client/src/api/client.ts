// API Client for Rin - Type-safe HTTP client to replace Eden
// This client provides a clean, type-safe interface for all backend API endpoints

import { getAuthToken } from "../utils/auth";
import { endpoint } from "../config";

// Import shared types
import type {
  ApiResponse,
  RequestOptions,
  Feed,
  FeedListResponse,
  TimelineItem,
  CreateFeedRequest,
  UpdateFeedRequest,
  AdjacentFeedResponse,
  UserProfile,
  UpdateProfileRequest,
  Tag,
  TagDetail,
  Comment,
  CreateCommentRequest,
  Friend,
  FriendListResponse,
  CreateFriendRequest,
  UpdateFriendRequest,
  Moment,
  CreateMomentRequest,
  ConfigType,
  ConfigResponse,
  AIConfig,
  UploadResponse,
  StorageItem,
  StorageInput,
  StorageListResponse,
  StorageTestResponse,
  AuthStatus,
  LoginRequest,
  LoginResponse,
} from "@rin/api";

export interface SettingsConfigResponse {
  clientConfig: ConfigResponse;
  serverConfig: ConfigResponse;
}

export interface ConfigHealthItem {
  id: string;
  title: {
    key: string;
    values?: Record<string, string | number | boolean>;
  };
  status: "success" | "warning" | "danger";
  configured: boolean;
  impact: {
    key: string;
    values?: Record<string, string | number | boolean>;
  };
  summary: {
    key: string;
    values?: Record<string, string | number | boolean>;
  };
  suggestion?: {
    key: string;
    values?: Record<string, string | number | boolean>;
  };
  details?: Array<{
    key: string;
    values?: Record<string, string | number | boolean>;
  }>;
}

export interface ConfigHealthResponse {
  generatedAt: string;
  summary: Record<"success" | "warning" | "danger", number>;
  items: ConfigHealthItem[];
}

export interface QueueStatusItem {
  id: number;
  title: string | null;
  aiSummaryStatus: "idle" | "pending" | "processing" | "completed" | "failed";
  aiSummaryError: string;
  updatedAt: string;
  createdAt: string;
}

export interface QueueStatusResponse {
  queueConfigured: boolean;
  generatedAt: string;
  summary: Record<"idle" | "pending" | "processing" | "completed" | "failed", number>;
  items: QueueStatusItem[];
}

export interface QueueTaskActionResponse {
  success: boolean;
}

export interface CompatTasksResponse {
  generatedAt: string;
  aiSummary: {
    enabled: boolean;
    queueConfigured: boolean;
    eligible: number;
    forceEligible: number;
  };
  blurhash: {
    eligible: number;
  };
}

export interface CompatAISummaryActionResponse {
  queued: number;
  skipped: number;
  forced: boolean;
}

export interface CompatBlurhashCandidate {
  id: number;
  title: string | null;
  content: string;
}

export interface CompatBlurhashCandidatesResponse {
  generatedAt: string;
  items: CompatBlurhashCandidate[];
}

export interface CompatBlurhashApplyResponse {
  updated: boolean;
}

// 备份相关数据结构
export interface BackupPreviewResponse {
  ok: boolean;
  preview: {
    feedsCount: number;
    commentsCount: number;
    momentsCount: number;
    friendsCount: number;
    storagesCount: number;
  };
  targetStorage: {
    configured: boolean;
    name: string;
    folder: string;
  };
  targetGitHub: {
    configured: boolean;
    repo: string;
    branch: string;
    path: string;
  };
}

export interface BackupExportToStorageResponse {
  ok: boolean;
  filename: string;
  path: string;
  target: string;
  metadata: any;
  totalBackups: number;
  prunedCount: number;
}

export interface BackupStorageListResponse {
  ok: boolean;
  target: string;
  items: Array<{
    key: string;
    filename: string;
    createdAt: string;
    metadata?: any;
  }>;
  error?: string;
}

export interface BackupInspectResponse {
  ok: boolean;
  key: string;
  filename: string;
  exportedAt: string;
  metadata: any;
}

export interface BackupRestoreResponse {
  ok: boolean;
  message: string;
  counts: any;
}

// GitHub 备份配置与列表类型
export interface GitHubBackupConfigResponse {
  ok: boolean;
  configured: boolean;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  hasToken: boolean;
}

export interface GitHubBackupItem {
  filename: string;
  path: string;
  downloadUrl: string;
  size: number;
  sha: string;
  createdAt: string;
}

export interface GitHubBackupListResponse {
  ok: boolean;
  target: string;
  branch: string;
  items: GitHubBackupItem[];
  error?: string;
}

// Re-export for external use
export type {
  ApiResponse,
  RequestOptions,
  Feed,
  FeedListResponse,
  TimelineItem,
  CreateFeedRequest,
  UpdateFeedRequest,
  AdjacentFeedResponse,
  UserProfile,
  UpdateProfileRequest,
  Tag,
  TagDetail,
  Comment,
  CreateCommentRequest,
  Friend,
  FriendListResponse,
  CreateFriendRequest,
  UpdateFriendRequest,
  Moment,
  CreateMomentRequest,
  ConfigType,
  ConfigResponse,
  AIConfig,
  UploadResponse,
  StorageItem,
  StorageInput,
  StorageListResponse,
  StorageTestResponse,
  AuthStatus,
  LoginRequest,
  LoginResponse,
} from "@rin/api";

/**
 * HTTP client for making API requests
 */
class HttpClient {
  constructor(private baseUrl: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options?.headers,
    };

    // Add auth token if available
    const token = getAuthToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (body !== undefined && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        credentials: "include",
      });

      // Handle 204 No Content
      if (response.status === 204) {
        return { data: undefined as T };
      }

      if (!response.ok) {
        let errorValue: unknown;
        const responseClone = response.clone();
        try {
          errorValue = await response.json();
        } catch {
          errorValue = await responseClone.text();
        }
        let errorMessage: string;
        if (typeof errorValue === 'string') {
          errorMessage = errorValue;
        } else if (errorValue && typeof errorValue === 'object') {
          const err = errorValue as any;
          errorMessage = err.error?.message || err.message || err.error || JSON.stringify(errorValue);
        } else {
          errorMessage = String(errorValue ?? response.statusText);
        }
        return {
          error: {
            status: response.status,
            value: errorMessage,
          },
        };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength === "0") {
        return { data: undefined as T };
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        const data = await response.json();
        return { data };
      }

      const text = await response.text();
      return { data: text as T };
    } catch (error) {
      return {
        error: {
          status: 0,
          value: error instanceof Error ? error.message : "Network error",
        },
      };
    }
  }

  async get<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, body, options);
  }

  async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("PUT", path, body, options);
  }

  async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("PATCH", path, body, options);
  }

  async delete<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", path, undefined, options);
  }
}

/**
 * Feed API methods
 */
class FeedAPI {
  constructor(private http: HttpClient) {}

  async list(params?: { page?: number; limit?: number; type?: 'draft' | 'unlisted' | 'normal' }): Promise<ApiResponse<FeedListResponse>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.type) searchParams.set("type", params.type);
    
    const query = searchParams.toString();
    return this.http.get<FeedListResponse>(`/api/feed${query ? `?${query}` : ""}`);
  }

  async timeline(): Promise<ApiResponse<TimelineItem[]>> {
    return this.http.get<TimelineItem[]>("/api/feed/timeline");
  }

  async get(id: number | string): Promise<ApiResponse<Feed>> {
    return this.http.get<Feed>(`/api/feed/${id}`);
  }

  async create(body: CreateFeedRequest): Promise<ApiResponse<{ insertedId: number }>> {
    return this.http.post<{ insertedId: number }>("/api/feed", body);
  }

  async update(id: number, body: UpdateFeedRequest): Promise<ApiResponse<void>> {
    return this.http.post<void>(`/api/feed/${id}`, body);
  }

  async delete(id: number): Promise<ApiResponse<void>> {
    return this.http.delete<void>(`/api/feed/${id}`);
  }

  async adjacent(id: number | string): Promise<ApiResponse<AdjacentFeedResponse>> {
    return this.http.get<AdjacentFeedResponse>(`/api/feed/adjacent/${id}`);
  }

  async setTop(id: number, top: number): Promise<ApiResponse<void>> {
    return this.http.post<void>(`/api/feed/top/${id}`, { top });
  }
}

/**
 * Tag API methods
 */
class TagAPI {
  constructor(private http: HttpClient) {}

  async list(): Promise<ApiResponse<Tag[]>> {
    return this.http.get<Tag[]>("/api/tag");
  }

  async get(name: string): Promise<ApiResponse<TagDetail>> {
    return this.http.get<TagDetail>(`/api/tag/${encodeURIComponent(name)}`);
  }
}

/**
 * Comment API methods
 */
class CommentAPI {
  constructor(private http: HttpClient) {}

  async list(feedId: number): Promise<ApiResponse<Comment[]>> {
    return this.http.get<Comment[]>(`/api/comment/${feedId}`);
  }

  async create(feedId: number, body: CreateCommentRequest): Promise<ApiResponse<Comment>> {
    return this.http.post<Comment>(`/api/comment/${feedId}`, body);
  }

  async delete(id: number): Promise<ApiResponse<void>> {
    return this.http.delete<void>(`/api/comment/${id}`);
  }
}

/**
 * User API methods
 */
class UserAPI {
  constructor(private http: HttpClient) {}

  async profile(): Promise<ApiResponse<UserProfile>> {
    return this.http.get<UserProfile>("/api/user/profile");
  }

  async updateProfile(body: UpdateProfileRequest): Promise<ApiResponse<{ success: boolean }>> {
    return this.http.put<{ success: boolean }>("/api/user/profile", body);
  }

  async logout(): Promise<ApiResponse<void>> {
    return this.http.post<void>("/api/user/logout");
  }

  githubAuth(): string {
    return `${endpoint}/api/user/github`;
  }
}

/**
 * Friend API methods
 */
class FriendAPI {
  constructor(private http: HttpClient) {}

  async list(): Promise<ApiResponse<FriendListResponse>> {
    return this.http.get<FriendListResponse>("/api/friend");
  }

  async create(body: CreateFriendRequest): Promise<ApiResponse<Friend>> {
    return this.http.post<Friend>(`/api/friend`, body);
  }

  async update(id: number, body: UpdateFriendRequest): Promise<ApiResponse<Friend>> {
    return this.http.put<Friend>(`/api/friend/${id}`, body);
  }

  async delete(id: number): Promise<ApiResponse<void>> {
    return this.http.delete<void>(`/api/friend/${id}`);
  }
}

/**
 * Moments API methods
 */
class MomentsAPI {
  constructor(private http: HttpClient) {}

  async list(params?: { page?: number; limit?: number }): Promise<ApiResponse<{ data: Moment[]; hasNext: boolean }>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    
    const query = searchParams.toString();
    return this.http.get<{ data: Moment[]; hasNext: boolean }>(`/api/moments${query ? `?${query}` : ""}`);
  }

  async create(body: CreateMomentRequest): Promise<ApiResponse<Moment>> {
    return this.http.post<Moment>("/api/moments", body);
  }

  async update(id: number, body: CreateMomentRequest): Promise<ApiResponse<Moment>> {
    return this.http.post<Moment>(`/api/moments/${id}`, body);
  }

  async delete(id: number): Promise<ApiResponse<void>> {
    return this.http.delete<void>(`/api/moments/${id}`);
  }
}

/**
 * Config API methods
 */
class ConfigAPI {
  constructor(private http: HttpClient) {}

  async getAll(): Promise<ApiResponse<SettingsConfigResponse>> {
    return this.http.get<SettingsConfigResponse>("/api/config");
  }

  async get(type: ConfigType): Promise<ApiResponse<ConfigResponse>> {
    return this.http.get<ConfigResponse>(`/api/config/${type}`);
  }

  async updateAll(body: SettingsConfigResponse): Promise<ApiResponse<SettingsConfigResponse>> {
    return this.http.post<SettingsConfigResponse>("/api/config", body);
  }

  async update(type: ConfigType, body: Record<string, unknown>): Promise<ApiResponse<void>> {
    return this.http.post<void>(`/api/config/${type}`, body);
  }

  async clearCache(): Promise<ApiResponse<void>> {
    return this.http.delete<void>("/api/config/cache");
  }

  async getHealth(): Promise<ApiResponse<ConfigHealthResponse>> {
    return this.http.get<ConfigHealthResponse>("/api/config/health");
  }

  async getQueueStatus(): Promise<ApiResponse<QueueStatusResponse>> {
    return this.http.get<QueueStatusResponse>("/api/config/queue-status");
  }

  async getCompatTasks(): Promise<ApiResponse<CompatTasksResponse>> {
    return this.http.get<CompatTasksResponse>("/api/config/compat-tasks");
  }

  async runCompatAISummary(force = false): Promise<ApiResponse<CompatAISummaryActionResponse>> {
    return this.http.post<CompatAISummaryActionResponse>("/api/config/compat-tasks/ai-summary", { force });
  }

  async getCompatBlurhashCandidates(): Promise<ApiResponse<CompatBlurhashCandidatesResponse>> {
    return this.http.get<CompatBlurhashCandidatesResponse>("/api/config/compat-tasks/blurhash");
  }

  async applyCompatBlurhash(feedId: number, content: string): Promise<ApiResponse<CompatBlurhashApplyResponse>> {
    return this.http.post<CompatBlurhashApplyResponse>(`/api/config/compat-tasks/blurhash/${feedId}`, { content });
  }

  async retryQueueTask(feedId: number): Promise<ApiResponse<QueueTaskActionResponse>> {
    return this.http.post<QueueTaskActionResponse>(`/api/config/queue-status/${feedId}/retry`);
  }

  async deleteQueueTask(feedId: number): Promise<ApiResponse<QueueTaskActionResponse>> {
    return this.http.delete<QueueTaskActionResponse>(`/api/config/queue-status/${feedId}`);
  }

  async testAI(body: {
    provider?: string;
    model?: string;
    api_url?: string;
    api_key?: string;
    testPrompt?: string;
  }): Promise<ApiResponse<{ success: boolean; response?: string; error?: string; details?: string; provider?: string; model?: string }>> {
    return this.http.post<any>("/api/config/test-ai", body);
  }

  async testWebhook(body: {
    webhook_url?: string;
    "webhook.method"?: string;
    "webhook.content_type"?: string;
    "webhook.headers"?: string;
    "webhook.body_template"?: string;
    test_message?: string;
  }): Promise<ApiResponse<{ success: boolean; error?: string; details?: string }>> {
    return this.http.post<{ success: boolean; error?: string; details?: string }>("/api/config/test-webhook", body);
  }
}

/**
 * AI Config API methods (deprecated)
 */
class AIConfigAPI {
  constructor(private http: HttpClient) {}

  async get(): Promise<ApiResponse<AIConfig>> {
    return this.http.get<AIConfig>("/api/ai-config");
  }

  async update(body: Partial<AIConfig>): Promise<ApiResponse<void>> {
    return this.http.post<void>("/api/ai-config", body);
  }
}

export const PROXY_UPLOAD_LIMIT = 95 * 1024 * 1024;
export const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;
const DIRECT_UPLOAD_THRESHOLD = 8 * 1024 * 1024;

type PresignResponse =
  | { mode: "proxy" }
  | {
      mode: "direct";
      url: string;
      method: "PUT";
      headers: Record<string, string>;
      token: string;
    };

/**
 * Storage API methods
 */
class StorageAPI {
  constructor(private http: HttpClient) {}

  async uploadViaServer(file: File, key?: string): Promise<ApiResponse<UploadResponse>> {
    const formData = new FormData();
    formData.append("file", file);
    if (key) formData.append("key", key);

    return this.http.post<UploadResponse>("/api/storage", formData);
  }

  async upload(file: File, key?: string): Promise<ApiResponse<UploadResponse>> {
    if (file.size > MAX_UPLOAD_SIZE) {
      return { error: { status: 413, value: "文件不能超过 2GB" } };
    }

    let directError: string | undefined;
    if (file.size >= DIRECT_UPLOAD_THRESHOLD) {
      const presign = await this.http.post<PresignResponse>("/api/storage/presign", {
        name: key || file.name,
        size: file.size,
        type: file.type,
      });
      if (!presign.error && presign.data?.mode === "direct") {
        try {
          const response = await fetch(presign.data.url, {
            method: presign.data.method,
            headers: presign.data.headers,
            body: file,
          });
          if (!response.ok) {
            throw new Error(`存储返回 ${response.status}`);
          }
          return this.http.post<UploadResponse>("/api/storage/complete", { token: presign.data.token });
        } catch (error) {
          directError =
            error instanceof TypeError
              ? "直传失败，请检查存储桶是否已配置 CORS（允许当前站点 PUT 上传）"
              : error instanceof Error
                ? error.message
                : "直传失败";
          console.warn("[storage] direct upload failed, falling back to server upload:", error);
        }
      }
    }

    if (file.size > PROXY_UPLOAD_LIMIT) {
      return {
        error: {
          status: 413,
          value:
            directError ??
            `文件超过 ${Math.floor(PROXY_UPLOAD_LIMIT / 1024 / 1024)}MB，需要在「后台 → 存储管理」添加 S3 / R2 存储后才能上传大文件`,
        },
      };
    }

    return this.uploadViaServer(file, key);
  }
}

/**
 * Storage admin API methods
 */
class StorageAdminAPI {
  constructor(private http: HttpClient) {}

  list(): Promise<ApiResponse<StorageListResponse>> {
    return this.http.get<StorageListResponse>("/api/storages");
  }

  create(body: StorageInput): Promise<ApiResponse<StorageItem>> {
    return this.http.post<StorageItem>("/api/storages", body);
  }

  update(id: number, body: StorageInput): Promise<ApiResponse<StorageItem>> {
    return this.http.put<StorageItem>(`/api/storages/${id}`, body);
  }

  remove(id: number, force = false): Promise<ApiResponse<{ ok: boolean }>> {
    return this.http.delete<{ ok: boolean }>(`/api/storages/${id}${force ? "?force=1" : ""}`);
  }

  test(id: number): Promise<ApiResponse<StorageTestResponse>> {
    return this.http.post<StorageTestResponse>(`/api/storages/${id}/test`, {});
  }

  testConfig(body: StorageInput): Promise<ApiResponse<StorageTestResponse>> {
    return this.http.post<StorageTestResponse>("/api/storages/test-config", body);
  }

  testDefault(): Promise<ApiResponse<StorageTestResponse>> {
    return this.http.post<StorageTestResponse>("/api/storages/test-default", {});
  }
}

/**
 * Backup API methods (全量备份与容灾恢复)
 */
class BackupAPI {
  constructor(private http: HttpClient) {}

  // 1. 获取预备份统计信息
  getPreview(): Promise<ApiResponse<BackupPreviewResponse>> {
    return this.http.get<BackupPreviewResponse>("/api/backup/preview");
  }

  // 2. 本地下载
  async download(): Promise<{ ok: boolean; error?: string; filename?: string }> {
    const token = getAuthToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const res = await fetch(`${endpoint}/api/backup/export`, {
        method: "GET",
        headers,
        credentials: "include",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: text || `下载失败 (${res.status})` };
      }

      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = /filename="?([^"]+)"?/.exec(disposition);
      const filename = match ? match[1] : `rin-backup-${new Date().toISOString().slice(0, 10)}.json`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      return { ok: true, filename };
    } catch (e: any) {
      return { ok: false, error: e.message || "下载失败" };
    }
  }

  // 3. 归档到存储桶
  exportToStorage(): Promise<ApiResponse<BackupExportToStorageResponse>> {
    return this.http.post<BackupExportToStorageResponse>("/api/backup/export-to-storage", {});
  }

  // 4. 获取存储桶备份列表
  listStorageBackups(): Promise<ApiResponse<BackupStorageListResponse>> {
    return this.http.get<BackupStorageListResponse>("/api/backup/storage-list");
  }

  // 4.1 检查存储桶指定路径的备份文件
  inspectStorageBackup(key: string): Promise<ApiResponse<BackupInspectResponse>> {
    return this.http.post<BackupInspectResponse>("/api/backup/inspect-storage-backup", { key });
  }

  // 5. 从存储桶恢复
  restoreFromStorage(key: string): Promise<ApiResponse<BackupRestoreResponse>> {
    return this.http.post<BackupRestoreResponse>("/api/backup/restore-from-storage", { key });
  }

  // 6. 从本地文件恢复
  importFromFile(file: File): Promise<ApiResponse<BackupRestoreResponse>> {
    const formData = new FormData();
    formData.append("file", file);
    return this.http.post<BackupRestoreResponse>("/api/backup/import", formData);
  }

  // =================== GitHub 专属备份能力 ===================

  // 7. 获取 GitHub 备份配置
  getGitHubConfig(): Promise<ApiResponse<GitHubBackupConfigResponse>> {
    return this.http.get<GitHubBackupConfigResponse>("/api/backup/github-config");
  }

  // 8. 保存 GitHub 备份配置
  saveGitHubConfig(body: {
    owner: string;
    repo: string;
    branch?: string;
    path?: string;
    token?: string;
  }): Promise<ApiResponse<{ ok: boolean; message: string }>> {
    return this.http.post<{ ok: boolean; message: string }>("/api/backup/github-config", body);
  }

  // 9. 测试 GitHub 仓库连接与私有属性
  testGitHubConnection(): Promise<ApiResponse<{ ok: boolean; isPrivate: boolean; message: string; defaultBranch?: string }>> {
    return this.http.post<{ ok: boolean; isPrivate: boolean; message: string; defaultBranch?: string }>("/api/backup/github-test", {});
  }

  // 10. 备份到 GitHub 仓库
  exportToGitHub(): Promise<ApiResponse<{
    ok: boolean;
    filename: string;
    path: string;
    target: string;
    commitSha: string;
    htmlUrl: string;
    metadata: any;
  }>> {
    return this.http.post<any>("/api/backup/export-to-github", {});
  }

  // 11. 列出 GitHub 仓库备份列表
  listGitHubBackups(): Promise<ApiResponse<GitHubBackupListResponse>> {
    return this.http.get<GitHubBackupListResponse>("/api/backup/github-list");
  }

  // 12. 预览指定的 GitHub 备份
  inspectGitHubBackup(path: string): Promise<ApiResponse<BackupInspectResponse>> {
    return this.http.post<BackupInspectResponse>("/api/backup/inspect-github-backup", { path });
  }

  // 13. 从 GitHub 仓库恢复
  restoreFromGitHub(path: string): Promise<ApiResponse<BackupRestoreResponse>> {
    return this.http.post<BackupRestoreResponse>("/api/backup/restore-from-github", { path });
  }
}

/**
 * Search API methods
 */
class SearchAPI {
  constructor(private http: HttpClient) {}

  async search(keyword: string, params?: { page?: number; limit?: number }): Promise<ApiResponse<FeedListResponse>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());

    const query = searchParams.toString();
    return this.http.get<FeedListResponse>(`/api/search/${encodeURIComponent(keyword)}${query ? `?${query}` : ""}`);
  }
}

/**
 * Auth API methods
 */
class AuthAPI {
  constructor(private http: HttpClient) {}

  async status(): Promise<ApiResponse<AuthStatus>> {
    return this.http.get<AuthStatus>("/api/auth/status");
  }

  async login(body: LoginRequest): Promise<ApiResponse<LoginResponse>> {
    return this.http.post<LoginResponse>("/api/auth/login", body);
  }
}

/**
 * WordPress Import API methods
 */
class WordPressAPI {
  constructor(private http: HttpClient) {}

  async import(xml: string): Promise<ApiResponse<{ imported: number }>> {
    return this.http.post<{ imported: number }>("/api/wp", { xml });
  }
}

/**
 * RSS API methods
 */
class RSSAPI {
  constructor(private baseUrl: string) {}

  async getRSS(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/rss.xml`);
    return response.text();
  }

  async getAtom(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/atom.xml`);
    return response.text();
  }

  async getJSON(): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/rss.json`);
    return response.json();
  }
}

// ============================================================================
// Main API Client Class
// ============================================================================

export class ApiClient {
  private http: HttpClient;
  feed: FeedAPI;
  tag: TagAPI;
  comment: CommentAPI;
  user: UserAPI;
  friend: FriendAPI;
  moments: MomentsAPI;
  config: ConfigAPI;
  aiConfig: AIConfigAPI;
  storage: StorageAPI;
  storages: StorageAdminAPI;
  backup: BackupAPI;
  search: SearchAPI;
  auth: AuthAPI;
  wp: WordPressAPI;
  rss: RSSAPI;

  constructor(baseUrl: string) {
    this.http = new HttpClient(baseUrl);
    this.feed = new FeedAPI(this.http);
    this.tag = new TagAPI(this.http);
    this.comment = new CommentAPI(this.http);
    this.user = new UserAPI(this.http);
    this.friend = new FriendAPI(this.http);
    this.moments = new MomentsAPI(this.http);
    this.config = new ConfigAPI(this.http);
    this.aiConfig = new AIConfigAPI(this.http);
    this.storage = new StorageAPI(this.http);
    this.storages = new StorageAdminAPI(this.http);
    this.backup = new BackupAPI(this.http);
    this.search = new SearchAPI(this.http);
    this.auth = new AuthAPI(this.http);
    this.wp = new WordPressAPI(this.http);
    this.rss = new RSSAPI(baseUrl);
  }
}

export function createClient(baseUrl: string): ApiClient {
  return new ApiClient(baseUrl);
}

export default ApiClient;
