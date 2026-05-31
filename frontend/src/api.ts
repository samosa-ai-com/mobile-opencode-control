import type {
  ChatMessage,
  AppStateResponse,
  OpenCodeCommand,
  NotificationSettings,
  Project,
  ProjectSession,
  ProjectRuntimeOptions,
  ProjectSessionsResponse,
  ProjectFileContent,
  ProjectDirectoryListResponse,
  ProjectsResponse,
  QuestionRequest,
  ScheduledTaskDetails,
  ScheduledTaskMetrics,
  ScheduledTaskRun,
  ScheduledTask,
  ProjectsSyncResponse,
  SessionDiffEntry,
  GitDiffEntry,
  GitDiffResponse,
  TimelineEvent,
  PrdData,
  PrdResponse,
} from "./types";


async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Ignore parse error and keep fallback message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function getAuthState(): Promise<boolean> {
  const data = await request<{ isAuthenticated: boolean }>("/api/auth/me");
  return data.isAuthenticated;
}

export async function login(password: string): Promise<void> {
  await request<{ ok: boolean }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export async function fetchAppState(): Promise<AppStateResponse> {
  return request<AppStateResponse>("/api/state");
}

export async function updateAppSettings(input: { defaultModel: string | null }): Promise<{ ok: boolean; defaultModel: string | null }> {
  return request("/api/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function fetchLanUrl(): Promise<{ url: string | null; port: number; ip: string | null }> {
  const response = await fetch("/api/lan-url");
  if (!response.ok) {
    throw new Error(`LAN URL fetch failed (${response.status})`);
  }
  return response.json() as Promise<{ url: string | null; port: number; ip: string | null }>;
}

export async function fetchProjects(input?: {
  limit?: number;
  offset?: number;
  query?: string;
}): Promise<ProjectsResponse> {
  const params = new URLSearchParams();
  if (typeof input?.limit === "number") {
    params.set("limit", String(input.limit));
  }
  if (typeof input?.offset === "number") {
    params.set("offset", String(input.offset));
  }
  if (typeof input?.query === "string" && input.query.trim()) {
    params.set("q", input.query.trim());
  }

  const query = params.toString();
  const path = query ? `/api/projects?${query}` : "/api/projects";
  return request<ProjectsResponse>(path);
}

export async function syncProjects(): Promise<ProjectsSyncResponse> {
  return request<ProjectsSyncResponse>("/api/projects/sync", {
    method: "POST",
  });
}

export async function createProject(input: {
  name: string;
  path: string;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function selectProject(projectId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/projects/${projectId}/select`, {
    method: "POST",
  });
}

export async function fetchMessages(projectId: string, sessionId?: string): Promise<{
  sessionId: string;
  messages: ChatMessage[];
  timelineEvents: TimelineEvent[];
}> {
  const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  return request(`/api/projects/${projectId}/messages${params}`);
}

export async function sendMessage(projectId: string, text: string, sessionId?: string | null): Promise<{
  sessionId: string;
  ok: boolean;
}> {
  return request(`/api/projects/${projectId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, sessionId: sessionId ?? null }),
  });
}

export async function abortSession(projectId: string, sessionId?: string | null): Promise<{ ok: boolean; sessionId: string }> {
  return request(`/api/projects/${projectId}/abort`, {
    method: "POST",
    body: JSON.stringify({ sessionId: sessionId ?? null }),
  });
}

export async function runCommand(
  projectId: string,
  command: string,
  argumentsList: string[],
  sessionId?: string | null
): Promise<{
  sessionId: string;
  message: ChatMessage;
}> {
  return request(`/api/projects/${projectId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command, arguments: argumentsList, sessionId: sessionId ?? null }),
  });
}

export async function fetchDiff(projectId: string): Promise<{
  sessionId: string;
  diff: SessionDiffEntry[];
}> {
  return request(`/api/projects/${projectId}/diff`);
}

export async function fetchPendingApprovals(projectId: string): Promise<{
  approvals: Array<{
    permissionId: string;
    title: string;
    details: string;
    createdAt: string;
  }>;
}> {
  return request(`/api/projects/${projectId}/approvals`);
}

export async function respondPermission(
  projectId: string,
  permissionId: string,
  responseValue: "approve" | "deny",
  remember = false
): Promise<{ ok: boolean; response: string }> {
  return request(`/api/projects/${projectId}/permissions/${permissionId}`, {
    method: "POST",
    body: JSON.stringify({ response: responseValue, remember }),
  });
}

export async function fetchPendingQuestions(projectId: string): Promise<{
  questions: QuestionRequest[];
}> {
  return request(`/api/projects/${projectId}/questions`);
}

export async function replyQuestion(
  projectId: string,
  requestId: string,
  answers: string[][]
): Promise<{ ok: boolean; requestId: string }> {
  return request(`/api/projects/${projectId}/questions/${encodeURIComponent(requestId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  });
}

export async function rejectQuestion(
  projectId: string,
  requestId: string
): Promise<{ ok: boolean; requestId: string }> {
  return request(`/api/projects/${projectId}/questions/${encodeURIComponent(requestId)}/reject`, {
    method: "POST",
  });
}

export async function fetchNotificationSettings(): Promise<NotificationSettings> {
  return request("/api/notifications/settings");
}

export async function updateNotificationSettings(input: NotificationSettings): Promise<NotificationSettings & { ok: boolean }> {
  return request("/api/notifications/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function testNtfyNotification(input?: {
  title?: string;
  message?: string;
  ntfyTopicUrl?: string;
}): Promise<{ ok: boolean }> {
  return request("/api/notifications/ntfy/test", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function sendNtfyNotification(input: {
  title?: string;
  message: string;
  ntfyTopicUrl?: string;
}): Promise<{ ok: boolean }> {
  return request("/api/notifications/ntfy/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function opencodeHealth(): Promise<{
  healthy: boolean;
  upstream?: { healthy?: boolean; version?: string };
  error?: string;
}> {
  return request("/api/opencode/health");
}

export async function fetchOpenCodeCommands(): Promise<{ commands: OpenCodeCommand[] }> {
  return request("/api/opencode/commands");
}

export async function fetchProjectRuntime(projectId: string): Promise<ProjectRuntimeOptions> {
  return request(`/api/projects/${projectId}/runtime`);
}

export async function updateProjectRuntime(
  projectId: string,
  input: { model: string | null; agent: string | null }
): Promise<{ ok: boolean; selectedModel: string | null; selectedAgent: string | null }> {
  return request(`/api/projects/${projectId}/runtime`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function fetchProjectSessions(projectId: string): Promise<ProjectSessionsResponse> {
  return request(`/api/projects/${projectId}/sessions`);
}

export async function createProjectSession(projectId: string): Promise<{
  ok: boolean;
  activeSessionId: string;
}> {
  return request(`/api/projects/${projectId}/sessions`, {
    method: "POST",
  });
}

export async function updateProjectSession(
  projectId: string,
  sessionId: string
): Promise<{ ok: boolean; activeSessionId: string }> {
  return request(`/api/projects/${projectId}/session`, {
    method: "PUT",
    body: JSON.stringify({ sessionId }),
  });
}

export async function deleteProjectSession(
  projectId: string,
  sessionId: string
): Promise<{
  ok: boolean;
  deletedSessionId: string;
  activeSessionId: string | null;
  sessions: ProjectSession[];
  projectDeleted?: boolean;
  deletedProjectId?: string | null;
  activeProjectId?: string | null;
}> {
  return request(`/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function compactSession(
  projectId: string,
  sessionId: string,
  providerID: string,
  modelID: string
): Promise<{ ok: boolean; sessionId: string }> {
  return request(`/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/summarize`, {
    method: "POST",
    body: JSON.stringify({ providerID, modelID }),
  });
}

export async function fetchProjectDirectoryEntries(
  projectId: string,
  directory: string
): Promise<ProjectDirectoryListResponse> {
  const params = new URLSearchParams();
  if (directory.trim()) {
    params.set("dir", directory.trim());
  }
  const query = params.toString();
  const path = query
    ? `/api/projects/${projectId}/files/list?${query}`
    : `/api/projects/${projectId}/files/list`;
  return request(path);
}

export async function fetchProjectFileContent(projectId: string, path: string): Promise<ProjectFileContent> {
  const params = new URLSearchParams({ path });
  return request(`/api/projects/${projectId}/files/content?${params.toString()}`);
}

export function projectFileDownloadUrl(projectId: string, path: string): string {
  const params = new URLSearchParams({ path });
  return `/api/projects/${projectId}/files/download?${params.toString()}`;
}

export function projectArchiveDownloadUrl(projectId: string): string {
  return `/api/projects/${projectId}/files/archive`;
}

export async function fetchSchedulerStatus(): Promise<{
  scheduler: {
    running: boolean;
    pollIntervalSeconds: number;
    taskRunRetentionDays: number;
    lastLoopAt: string | null;
    lastLoopError: string | null;
    lastPruneAt: string | null;
    lastPrunedCount: number;
  };
}> {
  return request("/api/scheduler/status");
}

export async function transcribeAudio(input: {
  audio: Blob;
  filename?: string;
  model?: string;
  language?: string;
}): Promise<{ text: string; model: string; raw: Record<string, unknown> }> {
  const form = new FormData();
  form.append("audio", input.audio, input.filename ?? "recording.webm");
  if (input.model) {
    form.append("model", input.model);
  }
  if (input.language) {
    form.append("language", input.language);
  }

  const response = await fetch("/api/stt/transcribe", {
    method: "POST",
    credentials: "include",
    body: form,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Ignore parse failures.
    }
    throw new Error(message);
  }

  return (await response.json()) as { text: string; model: string; raw: Record<string, unknown> };
}

export async function speakText(input: {
  text: string;
  model?: string;
  voice?: string;
  format?: string;
}): Promise<Blob> {
  const response = await fetch("/api/tts/speak", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Ignore parse failures.
    }
    throw new Error(message);
  }

  return await response.blob();
}

export async function fetchScheduledTask(projectId: string): Promise<ScheduledTaskDetails> {
  return request(`/api/projects/${projectId}/task`);
}

export async function saveScheduledTask(
  projectId: string,
  input: Partial<ScheduledTask> & { instruction: string; intervalMinutes: number; enabled: boolean }
): Promise<{ task: ScheduledTask; tasks: ScheduledTask[] }> {
  return request(`/api/projects/${projectId}/task`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteScheduledTask(
  projectId: string,
  taskId?: string | null
): Promise<{ ok: boolean; deleted: boolean }> {
  const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
  return request(`/api/projects/${projectId}/task${query}`, {
    method: "DELETE",
  });
}

export async function runScheduledTaskNow(
  projectId: string,
  taskId?: string | null
): Promise<{ task: ScheduledTask; run: ScheduledTaskRun; metrics?: ScheduledTaskMetrics }> {
  return request(`/api/projects/${projectId}/task/run`, {
    method: "POST",
    body: JSON.stringify({ taskId }),
  });
}

export async function fetchScheduledTaskRuns(
  projectId: string,
  limit = 20,
  taskId?: string | null
): Promise<{ runs: ScheduledTaskRun[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (taskId) {
    params.set("taskId", taskId);
  }
  return request(`/api/projects/${projectId}/task/runs?${params.toString()}`);
}

export async function fetchScheduledTasks(projectId: string): Promise<{ tasks: ScheduledTask[] }> {
  return request(`/api/projects/${projectId}/tasks`);
}

export async function pauseScheduledTask(projectId: string, taskId: string): Promise<{ task: ScheduledTask }> {
  return request(`/api/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST" });
}

export async function resumeScheduledTask(projectId: string, taskId: string): Promise<{ task: ScheduledTask }> {
  return request(`/api/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
}

export async function previewScheduledTask(
  projectId: string,
  input: Partial<ScheduledTask>
): Promise<{ runs: string[] }> {
  return request(`/api/projects/${projectId}/tasks/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchProjectPrd(projectId: string): Promise<PrdResponse> {
  return request(`/api/projects/${projectId}/prd`);
}

export async function initProjectPrd(
  projectId: string,
  prd?: PrdData
): Promise<PrdResponse> {
  return request(`/api/projects/${projectId}/prd`, {
    method: "PUT",
    body: JSON.stringify(prd ? { prd } : {}),
  });
}

export interface GitStatusResponse {
  untracked: string[];
  changed: string[];
  staged: string[];
  isClean: boolean;
  branch: string;
  remotes: string[];
  remoteDetails: Array<{
    name: string;
    url: string | null;
  }>;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasCommits: boolean;
  lastCommit: {
    shortSha: string;
    message: string;
  } | null;
  notGit?: boolean;
}

export interface GitCommitEntry {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string | null;
  parents: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  refs: string[];
}

export interface GitBranchSummary {
  name: string;
  isCurrent?: boolean;
  upstream?: string | null;
  trackedBy?: string | null;
  remoteName?: string;
  branchName?: string;
  lastCommit: GitCommitEntry | null;
}

export interface GitBranchesResponse {
  currentBranch: string;
  detached: boolean;
  local: GitBranchSummary[];
  remote: GitBranchSummary[];
}

export interface GitHistoryResponse {
  commits: GitCommitEntry[];
  hasMore: boolean;
}

export function apiGitInit(projectId: string) {
  return request<{ success: boolean }>(`/api/projects/${projectId}/git/init`, { method: "POST" });
}

export function apiGitStatus(projectId: string) {
  return request<GitStatusResponse>(`/api/projects/${projectId}/git/status`);
}

export function apiGitCommit(projectId: string, message: string) {
  return request<{ success: boolean }>(`/api/projects/${projectId}/git/commit`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export function apiGitCommitWithOptions(projectId: string, input: { message: string; stageAll?: boolean }) {
  return request<{ success: boolean }>(`/api/projects/${projectId}/git/commit`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiGitStageAll(projectId: string) {
  return request<{ success: boolean }>(`/api/projects/${projectId}/git/stage`, {
    method: "POST",
  });
}

export function apiGitBranches(projectId: string) {
  return request<GitBranchesResponse>(`/api/projects/${projectId}/git/branches`);
}

export function apiGitCheckoutBranch(projectId: string, name: string) {
  return request<{ success: boolean; currentBranch: string }>(`/api/projects/${projectId}/git/branches/checkout`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function apiGitCreateBranch(
  projectId: string,
  input: { name: string; startPoint?: string; checkout?: boolean }
) {
  return request<{ success: boolean; branch: string }>(`/api/projects/${projectId}/git/branches/create`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiGitTrackRemoteBranch(
  projectId: string,
  input: { remote: string; name: string; localName?: string }
) {
  return request<{ success: boolean; branch: string; upstream: string }>(
    `/api/projects/${projectId}/git/branches/track`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
}

export function apiGitHistory(projectId: string, input?: { limit?: number; skip?: number }) {
  const params = new URLSearchParams();
  if (typeof input?.limit === "number") {
    params.set("limit", String(input.limit));
  }
  if (typeof input?.skip === "number") {
    params.set("skip", String(input.skip));
  }
  const query = params.toString();
  const path = query ? `/api/projects/${projectId}/git/history?${query}` : `/api/projects/${projectId}/git/history`;
  return request<GitHistoryResponse>(path);
}

export function apiGitPush(projectId: string, remote: string) {
  return request<{ success: boolean }>(`/api/projects/${projectId}/git/push`, {
    method: "POST",
    body: JSON.stringify({ remote }),
  });
}

export function apiGitPull(projectId: string, remote: string) {
  return request<{ success: boolean }>(`/api/projects/${projectId}/git/pull`, {
    method: "POST",
    body: JSON.stringify({ remote }),
  });
}

export function apiGitDiff(projectId: string): Promise<GitDiffEntry[]> {
  return request<GitDiffResponse>(`/api/projects/${projectId}/git/diff`).then(r => r.diff);
}

export function apiGitRemote(projectId: string, name: string, url: string) {
  return request<{ success: boolean }>(`/api/projects/${projectId}/git/remote`, {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
}
