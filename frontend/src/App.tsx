import React, { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";


import GitView from "./GitView";

import {
  abortSession,
  compactSession,
  createProjectSession,
  createProject,
  deleteProjectSession,
  deleteScheduledTask,
  fetchDiff,
  fetchAppState,
  fetchLanUrl,
  fetchMessages,
  fetchNotificationSettings,
  fetchOpenCodeCommands,
  fetchPendingApprovals,
  fetchPendingQuestions,
  fetchProjectRuntime,
  fetchProjectSessions,
  fetchProjectFileContent,
  fetchProjectDirectoryEntries,
  fetchProjects,
  fetchSchedulerStatus,
  fetchScheduledTask,
  fetchScheduledTaskRuns,
  fetchProjectPrd,
  initProjectPrd,
  pauseScheduledTask,
  previewScheduledTask,
  rejectQuestion,
  replyQuestion,
  getAuthState,
  login,
  logout,
  opencodeHealth,
  respondPermission,
  resumeScheduledTask,
  runScheduledTaskNow,
  runCommand,
  saveScheduledTask,
  selectProject,
  sendMessage,
  sendNtfyNotification,
  speakText,
  testNtfyNotification,
  projectArchiveDownloadUrl,
  projectFileDownloadUrl,
  syncProjects,
  transcribeAudio,
  updateAppSettings,
  updateNotificationSettings,
  updateProjectRuntime,
  updateProjectSession,
  apiGitDiff,
} from "./api";

import type {
  ChatMessage,
  NotificationChannel,
  NotificationSettings,
  OpenCodeCommand,
  Project,
  ProjectFileContent,
  ProjectFileEntry,
  ProjectSession,
  PrdData,
  QuestionRequest,
  RuntimeAgentOption,
  RuntimeModelOption,
  ScheduledTask,
  ScheduledTaskRun,
  SessionDiffEntry,
  GitDiffEntry,
  TimelineEvent,
} from "./types";

import type { ApprovalRequest, BeforeInstallPromptEvent, DevFixtureMode, QuestionAnswerDraft, RenderedTimelineEntry, SchedulerStatus, TelemetryMarker, TelemetryMarkerCategory, TelemetryTimeWindow, TimelineEntry } from "./types/internal";
import { NOTIFICATION_PREFERENCE_KEY, TELEMETRY_CATEGORIES, TELEMETRY_TIME_WINDOWS } from "./types/internal";
import { formatCompactSessionId, formatElapsedShort, formatSessionOptionLabel, formatShortSessionLabel, formatTimelineDayLabel } from "./utils/formatting";
import { buildGroupedTimelineEntries, buildMessageStableKey, getNonTextParts, timelineEventToTaskRun } from "./utils/messageUtils";
import { buildProjectPathFromRoot, extractRootFromProjectPath, getSuggestedProjectRoot, normalizeProjectRootPath, projectInitials } from "./utils/projectUtils";
import { toDateInputPartsInTimezone, toDateTimeInputValueInTimezone, toIsoInTimezone } from "./utils/taskUtils";
import { parseApprovalFromEventLines, parseQuestionFromEventLines, classifyRawEvent, extractMessageFromEvent, extractMessagePartText, extractPartFromEvent, extractPartRemovalFromEvent, extractDiffFromEvent, extractSessionStatusFromEvent } from "./utils/streamUtils";
import { buildInitialQuestionDraft, buildQuestionReplyAnswers, getManualInstallMessage, inferTelemetryCategory, markerTimeWindowMs, nextReconnectDelayMs, parseSlashCommand, removeQuestionFromList, resolveDevFixtureMode, schedulerHeartbeatState, scrollEntryIntoView } from "./utils/miscUtils";
import { LoginView } from "./components/auth/LoginView";
import { AgentActivityCard } from "./components/chat/AgentActivityCard";
import { ChatStateCard } from "./components/chat/ChatStateCard";
import { ChatTransitionStrip } from "./components/chat/ChatTransitionStrip";
import { DiffPanel } from "./components/chat/DiffPanel";
import { EmptyState } from "./components/chat/EmptyState";
import { MessageBubble } from "./components/chat/MessageBubble";
import { TaskRunTimelineRow } from "./components/chat/TaskRunTimelineRow";
import { ProjectFilesPanel } from "./components/projects/ProjectFilesPanel";
import { VirtualizedProjectList } from "./components/projects/VirtualizedProjectList";
import { RALPH_GOAL_DEFINITION, RALPH_TASK_INSTRUCTION, RalphLoopPanel } from "./components/tasks/RalphLoopPanel";
import { ScheduledTaskPanel } from "./components/tasks/ScheduledTaskPanel";
import { InstallControls } from "./components/toolbar/InstallControls";
import { NotificationControls } from "./components/toolbar/NotificationControls";
import { RuntimeControls } from "./components/toolbar/RuntimeControls";
import { CommandPickerModal } from "./components/ui/CommandPickerModal";
import { FixtureBanner } from "./components/ui/FixtureBanner";
import { QuestionCard } from "./components/ui/QuestionCard";

export function App() {
  const PROJECTS_PAGE_SIZE = 120;
  const SESSION_LIST_REFRESH_MS = 15000;
  const MODEL_LIST_REFRESH_MS = 60000;
  const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = "opencode.desktopSidebarWidth";
  const fixtureMode = useMemo(() => resolveDevFixtureMode(), []);

  const [authLoading, setAuthLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [lanUrl, setLanUrl] = useState<string | null>(null);

  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectRootPath, setNewProjectRootPath] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [defaultProjectRoot, setDefaultProjectRoot] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [highlightedProjectId, setHighlightedProjectId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [, setSyncingProjects] = useState(false);
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false);
  const [projectsHasMore, setProjectsHasMore] = useState(false);
  const [projectsTotal, setProjectsTotal] = useState(0);
  const [searchProjects, setSearchProjects] = useState<Project[]>([]);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDebouncing, setSearchDebouncing] = useState(false);
  const [basePageLoads, setBasePageLoads] = useState(0);
  const [searchPageLoads, setSearchPageLoads] = useState(0);
  const [lastBaseLoadMs, setLastBaseLoadMs] = useState<number | null>(null);
  const [lastSearchLoadMs, setLastSearchLoadMs] = useState<number | null>(null);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [telemetryMarkers, setTelemetryMarkers] = useState<TelemetryMarker[]>([]);
  const [markerCategoryFilter, setMarkerCategoryFilter] = useState<
    Record<TelemetryMarkerCategory, boolean>
  >({
    search: true,
    project: true,
    chat: true,
    stream: true,
    system: true,
  });
  const [markerTimeWindow, setMarkerTimeWindow] = useState<TelemetryTimeWindow>("all");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [abortSuppressStreaming, setAbortSuppressStreaming] = useState(false);
  const [runIntentActive, setRunIntentActive] = useState(false);
  const [stopFeedbackLabel, setStopFeedbackLabel] = useState<string | null>(null);
  const [stopFeedbackUntilMs, setStopFeedbackUntilMs] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribingAudio, setTranscribingAudio] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [diffEntries, setDiffEntries] = useState<SessionDiffEntry[]>([]);
const [gitDiffEntries, setGitDiffEntries] = useState<GitDiffEntry[]>([]);
  const [projectFileEntries, setProjectFileEntries] = useState<ProjectFileEntry[]>([]);
  const [projectFilesTruncated, setProjectFilesTruncated] = useState(false);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [projectFileLoadedDirs, setProjectFileLoadedDirs] = useState<string[]>([]);
  const [projectFileLoadingDirs, setProjectFileLoadingDirs] = useState<string[]>([]);
  const [projectFilesError, setProjectFilesError] = useState<string | null>(null);
  const [projectFileQuery, setProjectFileQuery] = useState("");
  const [selectedProjectFilePath, setSelectedProjectFilePath] = useState<string | null>(null);
  const [selectedProjectFileContent, setSelectedProjectFileContent] = useState<ProjectFileContent | null>(null);
  const [projectFileContentLoading, setProjectFileContentLoading] = useState(false);
  const [projectFileContentError, setProjectFileContentError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState("idle");
  const [reconnectStartedAtMs, setReconnectStartedAtMs] = useState<number | null>(null);
  const [reconnectAttemptCount, setReconnectAttemptCount] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionAnswerDraft>>({});
  const [respondingQuestionId, setRespondingQuestionId] = useState<string | null>(null);
  const [respondingPermissionId, setRespondingPermissionId] = useState<string | null>(null);

  const [taskLoading, setTaskLoading] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskRunning, setTaskRunning] = useState(false);
  const [taskDeleting, setTaskDeleting] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [scheduledTask, setScheduledTask] = useState<ScheduledTask | null>(null);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [scheduledRuns, setScheduledRuns] = useState<ScheduledTaskRun[]>([]);
  const [taskTimelineEvents, setTaskTimelineEvents] = useState<TimelineEvent[]>([]);
  const [taskNameInput, setTaskNameInput] = useState("Scheduled task");
  const [taskDescriptionInput, setTaskDescriptionInput] = useState("");
  const [taskTypeInput, setTaskTypeInput] = useState<ScheduledTask["taskType"]>("interval");
  const [taskInstructionInput, setTaskInstructionInput] = useState("");
  const [taskIntervalInput, setTaskIntervalInput] = useState(15);
  const [taskCronInput, setTaskCronInput] = useState("0 9 * * *");
  const [taskOnceInput, setTaskOnceInput] = useState("");
  const [taskStartsDateInput, setTaskStartsDateInput] = useState("");
  const [taskStartsTimeInput, setTaskStartsTimeInput] = useState("");
  const [taskEndsDateInput, setTaskEndsDateInput] = useState("");
  const [taskEndsTimeInput, setTaskEndsTimeInput] = useState("");
  const [taskTimezoneInput, setTaskTimezoneInput] = useState("UTC");
  const [taskModelInput, setTaskModelInput] = useState("");
  const [taskAgentInput, setTaskAgentInput] = useState("");
  const [taskMaxRunsInput, setTaskMaxRunsInput] = useState("");
  const [taskTimeoutInput, setTaskTimeoutInput] = useState("");
  const [taskRetryCountInput, setTaskRetryCountInput] = useState("0");
  const [taskRetryBackoffInput, setTaskRetryBackoffInput] = useState("5");
  const [taskHeartbeatInput, setTaskHeartbeatInput] = useState(true);
  const [taskGoalInput, setTaskGoalInput] = useState("");
  const [taskAutoDisableOnGoalMetInput, setTaskAutoDisableOnGoalMetInput] = useState(true);
  const [taskNotificationUrlInput, setTaskNotificationUrlInput] = useState("");
  const [taskPreviewRuns, setTaskPreviewRuns] = useState<string[]>([]);
  const [taskEnabledInput, setTaskEnabledInput] = useState(true);

  const [prdData, setPrdData] = useState<PrdData | null>(null);
  const [prdLoading, setPrdLoading] = useState(false);
  const [prdError, setPrdError] = useState<string | null>(null);
  const [prdInitializing, setPrdInitializing] = useState(false);

  const [opencodeStatus, setOpencodeStatus] = useState("checking...");
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState(false);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [availableCommands, setAvailableCommands] = useState<OpenCodeCommand[]>([]);
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelOption[]>([]);
  const [runtimeAgents, setRuntimeAgents] = useState<RuntimeAgentOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [globalDefaultModel, setGlobalDefaultModel] = useState<string | null>(null);
  const [globalDefaultModelSaving, setGlobalDefaultModelSaving] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);
  const reloadMessageTimeoutRef = useRef<number | null>(null);
  const [projectSessions, setProjectSessions] = useState<ProjectSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionSwitching, setSessionSwitching] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionSwitchTargetLabel, setSessionSwitchTargetLabel] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [commandSearch, setCommandSearch] = useState("");
  const [expandedActivityEntries, setExpandedActivityEntries] = useState<Record<string, boolean>>({});
  const [expandedMessageEntries, setExpandedMessageEntries] = useState<Record<string, boolean>>({});
  const [expandedPartEntries, setExpandedPartEntries] = useState<Record<string, boolean>>({});
  const [notificationChannel, setNotificationChannel] = useState<NotificationChannel>("browser");
  const [ntfyTopicUrl, setNtfyTopicUrl] = useState("");
  const [notificationSettingsSaving, setNotificationSettingsSaving] = useState(false);
  const [notificationTesting, setNotificationTesting] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(NOTIFICATION_PREFERENCE_KEY) === "true";
  });
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }
    return Notification.permission;
  });
  const [isChatNearBottom, setIsChatNearBottom] = useState(true);
  const [unreadEntryId, setUnreadEntryId] = useState<string | null>(null);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installingApp, setInstallingApp] = useState(false);
  const [appInstalled, setAppInstalled] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    const nav = window.navigator as Navigator & { standalone?: boolean };
    return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
  });
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches
  );
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(() => {
    if (typeof window === "undefined") {
      return 390;
    }

    try {
      const rawValue = window.localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY);
      const parsedValue = rawValue ? Number(rawValue) : NaN;
      return Number.isFinite(parsedValue) ? parsedValue : 390;
    } catch {
      return 390;
    }
  });
  const [desktopProjectControlsCollapsed, setDesktopProjectControlsCollapsed] = useState(true);
  const [desktopChatToolbarCollapsed, setDesktopChatToolbarCollapsed] = useState(true);
  const [activeMainView, setActiveMainView] = useState<"chat" | "files" | "tasks" | "git">("chat");
  const [mobileProjectListOpen, setMobileProjectListOpen] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [mobileNewProjectOpen, setMobileNewProjectOpen] = useState(false);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const manualInstallMessage = getManualInstallMessage();
  const installMessage = appInstalled
    ? "This app is already installed and can launch in standalone mode."
    : deferredInstallPrompt
    ? "Install this app for quicker launch, home screen access, and offline shell support."
    : manualInstallMessage;
  const suggestedProjectRoot = useMemo(
    () => getSuggestedProjectRoot(projects, activeProjectId),
    [projects, activeProjectId]
  );

  const eventSourceRef = useRef<EventSource | null>(null);
  const refreshDebounceRef = useRef<number | null>(null);
  const streamReconnectTimerRef = useRef<number | null>(null);
  const streamReconnectAttemptRef = useRef(0);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const resizingSidebarRef = useRef(false);
  const projectFileDirectoryRequestsRef = useRef<Set<string>>(new Set());
  const syncInFlightRef = useRef(false);
  const desktopProjectSearchInputRef = useRef<HTMLInputElement | null>(null);
  const mobileProjectSearchInputRef = useRef<HTMLInputElement | null>(null);
  const projectSearchDebounceRef = useRef<number | null>(null);
  const searchRequestIdRef = useRef(0);
  const firstMessageMarkerProjectsRef = useRef<Set<string>>(new Set());
  const chatBodyRef = useRef<HTMLElement | null>(null);
  const timelineEntryRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const latestReadEntryIdByChatRef = useRef<Record<string, string>>({});
  const pendingOpenScrollRef = useRef<string | null>(null);
  const previousChatKeyRef = useRef<string | null>(null);
  const schedulerCardRef = useRef<HTMLDivElement | null>(null);
  const debugPanelRef = useRef<HTMLDetailsElement | null>(null);
  const schedulerCardPulseTimerRef = useRef<number | null>(null);
  const [schedulerCardPulse, setSchedulerCardPulse] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<BlobPart[]>([]);
  const prevQuestionCountRef = useRef(0);
  const hasSelectedProjectRef = useRef(false);
  const speakingAudioRef = useRef<HTMLAudioElement | null>(null);
  const speakingUrlRef = useRef<string | null>(null);
  const messageLoadRequestRef = useRef(0);
  const messageRequestInFlightRef = useRef(false);
  const pendingMessageRefreshRef = useRef<string | null>(null);
  const pendingScrollAnchorRef = useRef<{ entryId: string; top: number } | null>(null);
  const lastFinalAssistantMessageIdByChatRef = useRef<Record<string, string>>({});
  const awaitingFinalReplyNotificationByChatRef = useRef<Record<string, boolean>>({});
  const notificationDebounceTimerRef = useRef<number | null>(null);
  const idleDebounceTimerRef = useRef<number | null>(null);
  const lastBusyReceivedAtRef = useRef(0);
  const silenceTimerRef = useRef<number | null>(null);
  const pendingNotificationDataRef = useRef<{
    chatKey: string;
    projectName: string;
    messageText: string;
    messageId: string;
    shouldNotifyBrowser: boolean;
    shouldNotifyNtfy: boolean;
  } | null>(null);
  const prevApprovalCountRef = useRef(0);
  const previousActivityEntriesRef = useRef<Array<{ stateKey: string; childIds: string[] }>>([]);
  const taskLoadRequestRef = useRef(0);
  const sessionLoadRequestRef = useRef(0);
  const projectFilePreviewRequestRef = useRef(0);
  const projectFileLoadGenerationRef = useRef(0);
  const streamStatusRef = useRef(streamStatus);
  streamStatusRef.current = streamStatus;
  const lastAssistantMessageIdBySessionRef = useRef<Record<string, string>>({});

  function addTelemetryMarker(event: string, payload?: Record<string, unknown>) {
    const marker: TelemetryMarker = {
      id: `tm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      event,
      category: inferTelemetryCategory(event),
      at: new Date().toISOString(),
      payload: payload ?? {},
    };
    setTelemetryMarkers((current) => {
      const next = [...current, marker];
      if (next.length <= 80) {
        return next;
      }
      return next.slice(next.length - 80);
    });
  }

  function getPreferredSearchInput() {
    if (typeof document !== "undefined") {
      const activeElement = document.activeElement;
      if (activeElement === mobileProjectSearchInputRef.current) {
        return mobileProjectSearchInputRef.current;
      }
      if (activeElement === desktopProjectSearchInputRef.current) {
        return desktopProjectSearchInputRef.current;
      }
    }

    return isMobileViewport ? mobileProjectSearchInputRef.current : desktopProjectSearchInputRef.current;
  }

  function captureVisibleTimelineAnchor() {
    if (isChatNearBottom) {
      pendingScrollAnchorRef.current = null;
      return;
    }

    const body = chatBodyRef.current;
    if (!body) {
      pendingScrollAnchorRef.current = null;
      return;
    }

    const bodyTop = body.getBoundingClientRect().top;
    for (const entry of renderedTimelineEntries) {
      const node = timelineEntryRefs.current[entry.id];
      if (!node) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.bottom > bodyTop + 24) {
        pendingScrollAnchorRef.current = {
          entryId: entry.id,
          top: rect.top - bodyTop,
        };
        return;
      }
    }

    pendingScrollAnchorRef.current = null;
  }

  function resetTimelineExpansionState() {
    setExpandedActivityEntries({});
    setExpandedMessageEntries({});
    setExpandedPartEntries({});
    previousActivityEntriesRef.current = [];
  }

  function resetTaskForm() {
    setScheduledTask(null);
    setScheduledRuns([]);
    setTaskNameInput("Scheduled task");
    setTaskDescriptionInput("");
    setTaskTypeInput("interval");
    setTaskInstructionInput("");
    setTaskIntervalInput(15);
    setTaskCronInput("0 9 * * *");
    setTaskOnceInput("");
    setTaskStartsDateInput("");
    setTaskStartsTimeInput("");
    setTaskEndsDateInput("");
    setTaskEndsTimeInput("");
    setTaskTimezoneInput(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setTaskModelInput("");
    setTaskAgentInput("");
    setTaskMaxRunsInput("");
    setTaskTimeoutInput("");
    setTaskRetryCountInput("0");
    setTaskRetryBackoffInput("5");
    setTaskHeartbeatInput(true);
    setTaskGoalInput("");
    setTaskAutoDisableOnGoalMetInput(true);
    setTaskNotificationUrlInput("");
    setTaskPreviewRuns([]);
    setTaskEnabledInput(true);
  }

  function populateTaskForm(task: ScheduledTask) {
    setScheduledTask(task);
    setTaskNameInput(task.name || "Scheduled task");
    setTaskDescriptionInput(task.description ?? "");
    setTaskTypeInput(task.taskType || "interval");
    setTaskInstructionInput(task.instruction);
    setTaskIntervalInput(task.intervalMinutes || 15);
    setTaskCronInput(task.cronExpression ?? "0 9 * * *");
    setTaskOnceInput(toDateTimeInputValueInTimezone(task.onceRunAt, task.timezone || "UTC"));
    const startsAtParts = toDateInputPartsInTimezone(task.startsAt, task.timezone || "UTC");
    const endsAtParts = toDateInputPartsInTimezone(task.endsAt, task.timezone || "UTC");
    setTaskStartsDateInput(startsAtParts.date);
    setTaskStartsTimeInput(startsAtParts.time);
    setTaskEndsDateInput(endsAtParts.date);
    setTaskEndsTimeInput(endsAtParts.time);
    setTaskTimezoneInput(task.timezone || "UTC");
    setTaskModelInput(task.model ?? "");
    setTaskAgentInput(task.agent ?? "");
    setTaskMaxRunsInput(task.maxRuns === null ? "" : String(task.maxRuns));
    setTaskTimeoutInput(task.runTimeoutMinutes === null ? "" : String(task.runTimeoutMinutes));
    setTaskRetryCountInput(String(task.retryCount ?? 0));
    setTaskRetryBackoffInput(String(task.retryBackoffMinutes ?? 5));
    setTaskHeartbeatInput(task.heartbeatEnabled);
    setTaskGoalInput(task.goalDefinition ?? "");
    setTaskAutoDisableOnGoalMetInput(task.autoDisableOnGoalMet);
    setTaskNotificationUrlInput(task.notificationUrl ?? "");
    setTaskEnabledInput(task.enabled);
  }

  function focusSchedulerCard() {
    if (debugPanelRef.current && !debugPanelRef.current.open) {
      debugPanelRef.current.open = true;
    }
    const card = schedulerCardRef.current;
    if (!card) {
      return;
    }
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card.focus();
    setSchedulerCardPulse(true);
    if (schedulerCardPulseTimerRef.current !== null) {
      window.clearTimeout(schedulerCardPulseTimerRef.current);
    }
    schedulerCardPulseTimerRef.current = window.setTimeout(() => {
      schedulerCardPulseTimerRef.current = null;
      setSchedulerCardPulse(false);
    }, 1400);
  }

  async function requestBrowserNotificationPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }
    if (Notification.permission !== "default") {
      setNotificationPermission(Notification.permission);
      return;
    }
    try {
      const nextPermission = await Notification.requestPermission();
      setNotificationPermission(nextPermission);
    } catch {
      // Ignore notification permission failures.
    }
  }

  async function handleEnableNotifications() {
    setNotificationsEnabled(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, "true");
    }
    await requestBrowserNotificationPermission();
  }

  function handleDisableNotifications() {
    setNotificationsEnabled(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, "false");
    }
  }

  function handleQuestionOptionToggle(
    requestId: string,
    questionIndex: number,
    optionLabel: string,
    multiple: boolean
  ) {
    setQuestionDrafts((current) => {
      const baseDraft = current[requestId];
      if (!baseDraft) {
        return current;
      }
      const currentSelections = baseDraft.optionSelections[questionIndex] ?? [];
      const nextSelections = multiple
        ? currentSelections.includes(optionLabel)
          ? currentSelections.filter((item) => item !== optionLabel)
          : [...currentSelections, optionLabel]
        : currentSelections.includes(optionLabel)
          ? []
          : [optionLabel];
      return {
        ...current,
        [requestId]: {
          optionSelections: {
            ...baseDraft.optionSelections,
            [questionIndex]: nextSelections,
          },
          customValues: {
            ...baseDraft.customValues,
          },
        },
      };
    });
  }

  function handleQuestionCustomValueChange(requestId: string, questionIndex: number, value: string) {
    setQuestionDrafts((current) => {
      const baseDraft = current[requestId];
      if (!baseDraft) {
        return current;
      }
      return {
        ...current,
        [requestId]: {
          optionSelections: {
            ...baseDraft.optionSelections,
          },
          customValues: {
            ...baseDraft.customValues,
            [questionIndex]: value,
          },
        },
      };
    });
  }

  async function handleReplyQuestion(question: QuestionRequest) {
    if (!activeProjectId || respondingQuestionId) {
      return;
    }

    const draft = questionDrafts[question.id] ?? buildInitialQuestionDraft(question);
    setRespondingQuestionId(question.id);
    setProjectError(null);
    try {
      await replyQuestion(activeProjectId, question.id, buildQuestionReplyAnswers(question, draft));
      setPendingQuestions((current) => removeQuestionFromList(current, question.id));
      setQuestionDrafts((current) => {
        const next = { ...current };
        delete next[question.id];
        return next;
      });
      scheduleStreamRefresh(activeProjectId);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to submit question response");
    } finally {
      setRespondingQuestionId(null);
    }
  }

  async function handleRejectQuestion(question: QuestionRequest) {
    if (!activeProjectId || respondingQuestionId) {
      return;
    }

    setRespondingQuestionId(question.id);
    setProjectError(null);
    try {
      await rejectQuestion(activeProjectId, question.id);
      setPendingQuestions((current) => removeQuestionFromList(current, question.id));
      setQuestionDrafts((current) => {
        const next = { ...current };
        delete next[question.id];
        return next;
      });
      scheduleStreamRefresh(activeProjectId);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to dismiss question");
    } finally {
      setRespondingQuestionId(null);
    }
  }

  async function handleSaveNotificationSettings() {
    setNotificationSettingsSaving(true);
    setProjectError(null);
    try {
      const nextChannel = notificationsEnabled ? notificationChannel : "off";
      const result = await updateNotificationSettings({
        channel: nextChannel,
        ntfyTopicUrl: ntfyTopicUrl.trim(),
      });
      setNotificationChannel(result.channel);
      setNtfyTopicUrl(result.ntfyTopicUrl);
      const nextEnabled = result.channel !== "off";
      setNotificationsEnabled(nextEnabled);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, nextEnabled ? "true" : "false");
      }
      if (result.channel === "browser" || result.channel === "both") {
        await requestBrowserNotificationPermission();
      }
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to save notification settings");
    } finally {
      setNotificationSettingsSaving(false);
    }
  }

  async function handleSaveGlobalDefaultModel(value: string | null) {
    setGlobalDefaultModelSaving(true);
    setProjectError(null);
    try {
      const result = await updateAppSettings({ defaultModel: value });
      setGlobalDefaultModel(result.defaultModel);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to save default model");
    } finally {
      setGlobalDefaultModelSaving(false);
    }
  }

  async function handleTestNtfy() {
    setNotificationTesting(true);
    setProjectError(null);
    try {
      await testNtfyNotification({
        title: activeProject?.name ? `${activeProject.name} notification test` : "OpenCode Controller",
        message: "Test notification from mobile-opencode-control",
        ntfyTopicUrl: ntfyTopicUrl.trim() || undefined,
      });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to send ntfy test notification");
    } finally {
      setNotificationTesting(false);
    }
  }

  function stopSpeakingAudio() {
    if (speakingAudioRef.current) {
      speakingAudioRef.current.pause();
      speakingAudioRef.current = null;
    }
    if (speakingUrlRef.current) {
      URL.revokeObjectURL(speakingUrlRef.current);
      speakingUrlRef.current = null;
    }
    setSpeakingMessageId(null);
  }

  function cleanupMediaRecorder() {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      if (mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    mediaChunksRef.current = [];
    setRecording(false);
  }

  useEffect(() => {
    async function bootstrap() {
      try {
        const authenticated = await getAuthState();
        setIsAuthenticated(authenticated);
      } catch {
        setIsAuthenticated(false);
      } finally {
        setAuthLoading(false);
      }
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    const preferredRoot = normalizeProjectRootPath(suggestedProjectRoot || defaultProjectRoot);
    if (!preferredRoot) {
      return;
    }
    setNewProjectRootPath((current) => (current.trim() ? current : preferredRoot));
    setNewProjectPath((current) => (current.trim() ? current : preferredRoot));
  }, [defaultProjectRoot, suggestedProjectRoot]);

  function handleNewProjectNameInput(value: string) {
    setNewProjectName(value);
    const nextName = value.trim();
    const rootPath =
      newProjectRootPath || normalizeProjectRootPath(suggestedProjectRoot || defaultProjectRoot);
    setNewProjectPath(buildProjectPathFromRoot(rootPath, nextName));
  }

  function handleNewProjectPathInput(value: string) {
    const currentName = newProjectName.trim();
    const nextRootPath = extractRootFromProjectPath(value, currentName);
    setNewProjectRootPath(nextRootPath);
    if (!currentName) {
      setNewProjectPath(value);
      return;
    }
    setNewProjectPath(buildProjectPathFromRoot(nextRootPath, currentName));
  }

  async function refreshProjectsAndStatus(preferredProjectId?: string | null) {
    const requestedLimit = Math.max(PROJECTS_PAGE_SIZE, projects.length || 0);
    const startedAt = performance.now();
    const [projectData, health] = await Promise.all([
      fetchProjects({ limit: requestedLimit, offset: 0 }),
      opencodeHealth(),
    ]);
    setBasePageLoads((current) => current + 1);
    setLastBaseLoadMs(performance.now() - startedAt);
    setProjects(projectData.projects);
    setProjectsHasMore(projectData.hasMore);
    setProjectsTotal(projectData.total);
    const preferredProjectIsVisible =
      !!preferredProjectId && projectData.projects.some((project) => project.id === preferredProjectId);
    const serverActiveProjectIsVisible =
      !!projectData.activeProjectId &&
      projectData.projects.some((project) => project.id === projectData.activeProjectId);
    const nextActiveProjectId =
      (preferredProjectIsVisible ? preferredProjectId : null) ??
      (serverActiveProjectIsVisible ? projectData.activeProjectId : null) ??
      projectData.projects[0]?.id ??
      null;
    setActiveProjectId(nextActiveProjectId);

    if (health.healthy) {
      const version = health.upstream?.version ?? "unknown";
      setOpencodeStatus(`connected (v${version})`);
    } else {
      setOpencodeStatus(`offline (${health.error ?? "unknown"})`);
    }

    return nextActiveProjectId;
  }

  async function loadMoreProjects() {
    if (loadingMoreProjects || !projectsHasMore) {
      return;
    }

    setLoadingMoreProjects(true);
    try {
      const startedAt = performance.now();
      const page = await fetchProjects({ limit: PROJECTS_PAGE_SIZE, offset: projects.length });
      setBasePageLoads((current) => current + 1);
      setLastBaseLoadMs(performance.now() - startedAt);
      setProjects((current) => {
        const seen = new Set(current.map((project) => project.id));
        const additions = page.projects.filter((project) => !seen.has(project.id));
        return [...current, ...additions];
      });
      setProjectsHasMore(page.hasMore);
      setProjectsTotal(page.total);
      if (!activeProjectId && page.projects[0]) {
        setActiveProjectId(page.activeProjectId ?? page.projects[0].id);
      }
    } finally {
      setLoadingMoreProjects(false);
    }
  }

  async function loadSearchProjects(query: string, offset: number, reset: boolean) {
    if (searchLoading) {
      return;
    }

    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setSearchLoading(true);
    setSearchDebouncing(false);

    try {
      const startedAt = performance.now();
      const page = await fetchProjects({
        limit: PROJECTS_PAGE_SIZE,
        offset,
        query,
      });

      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      if (reset) {
        setSearchProjects(page.projects);
      } else {
        setSearchProjects((current) => {
          const seen = new Set(current.map((project) => project.id));
          const additions = page.projects.filter((project) => !seen.has(project.id));
          return [...current, ...additions];
        });
      }

      setSearchHasMore(page.hasMore);
      setSearchTotal(page.total);
      setSearchPageLoads((current) => current + 1);
      setLastSearchLoadMs(performance.now() - startedAt);
      setLastSearchQuery(query);
    } finally {
      if (requestId === searchRequestIdRef.current) {
        setSearchLoading(false);
      }
    }
  }

  async function handleSyncProjects() {
    if (syncInFlightRef.current) {
      return;
    }

    syncInFlightRef.current = true;
    setSyncingProjects(true);
    setProjectError(null);
    try {
      const result = await syncProjects();
      setProjects(result.projects);
      setProjectsHasMore(false);
      setProjectsTotal(result.projects.length);
      if (searchQuery) {
        void loadSearchProjects(searchQuery, 0, true);
      }
      const activeProjectStillVisible =
        !!activeProjectId && result.projects.some((project) => project.id === activeProjectId);
      const syncedActiveProjectVisible =
        !!result.activeProjectId && result.projects.some((project) => project.id === result.activeProjectId);
      const nextActiveId =
        (activeProjectStillVisible ? activeProjectId : null) ??
        (syncedActiveProjectVisible ? result.activeProjectId : null) ??
        result.projects[0]?.id ??
        null;
      setActiveProjectId(nextActiveId);
      if (nextActiveId) {
        await loadMessages(nextActiveId);
        void loadDiff(nextActiveId);
        void loadPendingApprovals(nextActiveId);
      }
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Unable to sync projects");
    } finally {
      syncInFlightRef.current = false;
      setSyncingProjects(false);
    }
  }

  useEffect(() => {
    fetchLanUrl().then((data) => setLanUrl(data.url)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setSearchDebouncing(false);
      return;
    }

    async function loadInitial() {
      try {
        const appState = await fetchAppState();
        const normalizedDefaultRoot = normalizeProjectRootPath(appState.defaultProjectRoot || "");
        if (normalizedDefaultRoot) {
          setDefaultProjectRoot(normalizedDefaultRoot);
        }
        if (appState.defaultModel) {
          setGlobalDefaultModel(appState.defaultModel);
        }
        await loadNotificationSettings();
        const nextActiveProjectId = await refreshProjectsAndStatus();
        if (nextActiveProjectId) {
          await loadMessages(nextActiveProjectId);
          void loadDiff(nextActiveProjectId);
          void loadPendingApprovals(nextActiveProjectId);
          void loadPendingQuestions(nextActiveProjectId);
          return;
        }

        const synced = await syncProjects();
        setProjects(synced.projects);
        setProjectsHasMore(false);
        setProjectsTotal(synced.projects.length);
        const syncedActiveId = synced.activeProjectId ?? synced.projects[0]?.id ?? null;
        setActiveProjectId(syncedActiveId);
        if (syncedActiveId) {
          await loadMessages(syncedActiveId);
          void loadDiff(syncedActiveId);
          void loadPendingApprovals(syncedActiveId);
          void loadPendingQuestions(syncedActiveId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load app state";
        setProjectError(message);
      }
    }

    void loadInitial();
  }, [isAuthenticated]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => {
      setIsMobileViewport(media.matches);
    };

    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileProjectListOpen(false);
      setMobileSettingsOpen(false);
      return;
    }

    if (!activeProjectId) {
      // Only auto-open project list if user has never had a selected project
      // (prevents redirect during reconnection or transient null states)
      if (!hasSelectedProjectRef.current) {
        setMobileProjectListOpen(true);
      }
    } else {
      hasSelectedProjectRef.current = true;
    }
  }, [activeProjectId, isMobileViewport]);


  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );
  const activeSession = useMemo(
    () => projectSessions.find((session) => session.id === activeSessionId) ?? null,
    [projectSessions, activeSessionId]
  );
  const contextUsage = useMemo(() => {
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.tokens);
    if (!lastAssistant?.tokens) return null;
    const selectedModelOption = runtimeModels.find((m) => m.id === selectedModel)
      ?? runtimeModels.find((m) => m.id === globalDefaultModel)
      ?? runtimeModels.find((m) => m.isDefault)
      ?? null;
    const contextLimit = selectedModelOption?.contextLimit ?? 0;
    if (!contextLimit) return null;
    const tokens = lastAssistant.tokens;
    const totalUsed = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
    const percentage = Math.round((totalUsed / contextLimit) * 100);
    return {
      used: totalUsed,
      limit: contextLimit,
      percentage,
      color: percentage >= 90 ? "red" : percentage >= 70 ? "yellow" : "green",
    };
  }, [messages, selectedModel, globalDefaultModel, runtimeModels]);
  const showMobileProjectList = isMobileViewport && (mobileProjectListOpen || !activeProjectId);
  const filteredCommandList = useMemo(() => {
    const query = commandSearch.trim().toLowerCase();
    if (!query) {
      return availableCommands;
    }
    return availableCommands.filter((command) => {
      return (
        command.name.toLowerCase().includes(query) ||
        command.description.toLowerCase().includes(query)
      );
    });
  }, [availableCommands, commandSearch]);
  const preferredProjectRoot = normalizeProjectRootPath(suggestedProjectRoot || defaultProjectRoot);
  const hasStreamingActivity = useMemo(() => {
    if (abortSuppressStreaming) {
      return false;
    }

    let latestAssistantTextMs = 0;
    let latestIntermediateAssistantMs = 0;

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }

      const timestamp = new Date(message.createdAt).getTime();
      if (!Number.isFinite(timestamp)) {
        continue;
      }

      if (message.text.trim()) {
        latestAssistantTextMs = Math.max(latestAssistantTextMs, timestamp);
      } else if (getNonTextParts(message).length > 0) {
        latestIntermediateAssistantMs = Math.max(latestIntermediateAssistantMs, timestamp);
      }
    }

    return latestIntermediateAssistantMs > latestAssistantTextMs;
  }, [messages, abortSuppressStreaming]);
  const hasActiveRun =
    (fixtureMode === "run-active" || Boolean(activeProject)) &&
    (sending ||
      aborting ||
      runIntentActive ||
      hasStreamingActivity ||
      fixtureMode === "run-active" ||
      activeProject?.sessionStatus === "running");
  const showReconnectFixture = fixtureMode === "reconnecting";
  const showLoadingFixture = fixtureMode === "chat-loading";
  const showSessionSwitchFixture = fixtureMode === "session-switching";
  const showApprovalFixture = fixtureMode === "approval-heavy";
  const showActivityChainFixture = fixtureMode === "activity-chain";
  const showDiffEmptyFixture = fixtureMode === "diff-empty";
  const showDiffLargeFixture = fixtureMode === "diff-large";
  const activeChatKey = activeProjectId && activeSessionId ? `${activeProjectId}:${activeSessionId}` : null;
  const fixturePendingApprovals = useMemo<ApprovalRequest[]>(() => {
    if (!showApprovalFixture) {
      return [];
    }

    const now = Date.now();
    return [
      {
        permissionId: "fixture-perm-shell",
        title: "Permission requested",
        details: "Allow shell command execution in /tmp for fixture preview?",
        createdAt: new Date(now - 35_000).toISOString(),
      },
      {
        permissionId: "fixture-perm-write",
        title: "Permission requested",
        details: "Allow file write in src/components for fixture preview?",
        createdAt: new Date(now - 24_000).toISOString(),
      },
      {
        permissionId: "fixture-perm-network",
        title: "Permission requested",
        details: "Allow network request to docs provider for fixture preview?",
        createdAt: new Date(now - 14_000).toISOString(),
      },
    ];
  }, [showApprovalFixture]);
  const visiblePendingApprovals = showApprovalFixture ? fixturePendingApprovals : pendingApprovals;
  const hasBlockingApprovals = visiblePendingApprovals.length > 0;
  const hasBlockingQuestions = pendingQuestions.length > 0;
  const timelineEntries = useMemo<TimelineEntry[]>(() => {
    const messageEntries: TimelineEntry[] = messages.map((message) => ({
      kind: "message",
      id: `m-${buildMessageStableKey(message)}`,
      createdAt: message.createdAt,
      message,
    }));

    const runEntries: TimelineEntry[] = [];
    for (const event of taskTimelineEvents) {
      const run = timelineEventToTaskRun(event);
      if (!run) {
        continue;
      }
      runEntries.push({
        kind: "task_run",
        id: `t-${event.id}`,
        createdAt: event.createdAt,
        run,
      });
    }

    const toMillis = (value: string) => {
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    };

    return [...messageEntries, ...runEntries].sort(
      (a, b) => toMillis(a.createdAt) - toMillis(b.createdAt)
    );
  }, [messages, taskTimelineEvents]);
  const effectiveTimelineEntries = useMemo<TimelineEntry[]>(() => {
    if (fixtureMode === "task-run-success" || fixtureMode === "task-run-error") {
      const now = new Date();
      const startedAt = new Date(now.getTime() - 2 * 60_000).toISOString();
      const finishedAt = fixtureMode === "task-run-success" ? now.toISOString() : new Date(now.getTime() - 30_000).toISOString();
      return [
        {
          kind: "task_run",
          id: `fixture-${fixtureMode}`,
          createdAt: startedAt,
          run: {
            id: `fixture-${fixtureMode}`,
            taskId: "fixture-task",
            projectId: activeProjectId ?? "fixture-project",
            status: fixtureMode === "task-run-success" ? "completed" : "failed",
            sessionId: activeSessionId,
            trigger: fixtureMode === "task-run-success" ? "schedule" : "manual",
            startedAt,
            finishedAt,
            heartbeatLoaded: fixtureMode === "task-run-success",
            runNumber: 1,
            modelUsed: null,
            agentUsed: null,
            timeoutUsed: null,
            goalAttempted: false,
            goalMet: null,
            goalOutput: null,
            retryAttempt: 0,
            outputPreview:
              fixtureMode === "task-run-success"
                ? "Checked repository state and posted a clean status update."
                : "Attempted scheduled review run before hitting a fixture error.",
            error: fixtureMode === "task-run-success" ? null : "Fixture error: simulated task failure for UI review.",
          },
        },
      ];
    }

    if (showActivityChainFixture) {
      const now = Date.now();
      const entries: TimelineEntry[] = [
        {
          kind: "message",
          id: "fixture-activity-user",
          createdAt: new Date(now - 70_000).toISOString(),
          message: {
            id: "fixture-activity-user",
            role: "user",
            createdAt: new Date(now - 70_000).toISOString(),
            text: "Review this repository and summarize the recent runtime UX changes.",
            parts: [{ type: "text", text: "Review this repository and summarize the recent runtime UX changes." }],
          },
        },
      ];

      for (let index = 0; index < 6; index += 1) {
        entries.push({
          kind: "message",
          id: `fixture-activity-${index}`,
          createdAt: new Date(now - (58_000 - index * 8_000)).toISOString(),
          message: {
            id: `fixture-activity-${index}`,
            role: "assistant",
            createdAt: new Date(now - (58_000 - index * 8_000)).toISOString(),
            text: "",
            parts: [
              {
                type: "tool-call",
                tool: index % 2 === 0 ? "read" : "grep",
                status: "completed",
                detail: index % 2 === 0 ? `Scanned App.tsx section ${index + 1}` : `Matched transition selector set ${index + 1}`,
              },
            ],
          },
        });
      }

      entries.push({
        kind: "message",
        id: "fixture-activity-final",
        createdAt: new Date(now - 8_000).toISOString(),
        message: {
          id: "fixture-activity-final",
          role: "assistant",
          createdAt: new Date(now - 8_000).toISOString(),
          text: "Runtime stop controls and transition strips were polished with reconnect context and fixture-backed QA states.",
          parts: [
            {
              type: "text",
              text: "Runtime stop controls and transition strips were polished with reconnect context and fixture-backed QA states.",
            },
          ],
        },
      });

      return entries;
    }

    return timelineEntries;
  }, [activeProjectId, activeSessionId, fixtureMode, showActivityChainFixture, timelineEntries]);
  const renderedTimelineEntries = useMemo<RenderedTimelineEntry[]>(
    () => buildGroupedTimelineEntries(effectiveTimelineEntries),
    [effectiveTimelineEntries]
  );

  const searchQuery = projectSearch.trim();
  const isSearchMode = searchQuery.length > 0;
  const visibleProjects = isSearchMode ? searchProjects : projects;
  const sortedVisibleProjects = useMemo(() => {
    return [...visibleProjects].sort((a, b) => {
      if (a.id === activeProjectId) return -1;
      if (b.id === activeProjectId) return 1;
      return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
    });
  }, [visibleProjects, activeProjectId]);
  const visibleProjectsHasMore = isSearchMode ? searchHasMore : projectsHasMore;
  const visibleProjectsTotal = isSearchMode ? searchTotal : projectsTotal;
  const isLoadingVisibleProjects = isSearchMode ? searchLoading : loadingMoreProjects;
  const searchSummaryLabel = searchQuery
    ? `${sortedVisibleProjects.length} result${sortedVisibleProjects.length === 1 ? "" : "s"}${visibleProjectsTotal > sortedVisibleProjects.length ? ` of ${visibleProjectsTotal}` : ""} for "${searchQuery}"`
    : `${sortedVisibleProjects.length} chat${sortedVisibleProjects.length === 1 ? "" : "s"}`;
  const reconnectElapsedMs = showReconnectFixture
    ? 42_000
    : reconnectStartedAtMs !== null
    ? Math.max(0, clockTick - reconnectStartedAtMs)
    : 0;
  const reconnectElapsedLabel = formatElapsedShort(reconnectElapsedMs);
  const reconnectAttemptLabel = showReconnectFixture
    ? 3
    : reconnectAttemptCount;
  const stopFeedbackVisible =
    Boolean(stopFeedbackLabel) &&
    stopFeedbackUntilMs !== null &&
    clockTick <= stopFeedbackUntilMs;
  const mobileSearchStatusLabel = searchQuery
    ? searchDebouncing
      ? `Searching for "${searchQuery}"...`
      : searchLoading
      ? `Loading results for "${searchQuery}"...`
      : searchSummaryLabel
    : searchSummaryLabel;
  const effectiveDiffEntries = useMemo<SessionDiffEntry[]>(() => {
    if (showDiffEmptyFixture) {
      return [];
    }

    if (showDiffLargeFixture) {
      return Array.from({ length: 28 }, (_, index) => ({
        path: `src/fixtures/file-${String(index + 1).padStart(2, "0")}.ts`,
        additions: 8 + index,
        deletions: index % 4,
      }));
    }

    return diffEntries;
  }, [diffEntries, showDiffEmptyFixture, showDiffLargeFixture]);
  const transitionStatus = useMemo(() => {
    if (showReconnectFixture || streamStatus === "reconnecting") {
      const attemptText = reconnectAttemptLabel > 0 ? `Retry ${reconnectAttemptLabel}` : "Retry pending";
      return {
        tone: "warn" as const,
        label: "Reconnecting to session stream",
        detail: `${attemptText} · ${reconnectElapsedLabel} elapsed. Waiting for the live event stream to reconnect. New updates will appear automatically.`,
      };
    }
    if (showSessionSwitchFixture || sessionSwitching) {
      const destination = showSessionSwitchFixture
        ? "voice_typing · Current · 01:44 PM"
        : sessionSwitchTargetLabel || "selected session";
      return {
        tone: "info" as const,
        label: "Switching sessions",
        detail: `Loading ${destination} and refreshing the current chat state.`,
      };
    }
    if (showLoadingFixture || messagesLoading) {
      return {
        tone: "info" as const,
        label: "Loading this session",
        detail: "Fetching message history, activity, and pending approvals for the selected project.",
      };
    }
    return null;
  }, [messagesLoading, reconnectAttemptLabel, reconnectElapsedLabel, sessionSwitchTargetLabel, sessionSwitching, showLoadingFixture, showReconnectFixture, showSessionSwitchFixture, streamStatus]);

  useEffect(() => {
    if (!hasActiveRun) {
      return;
    }
    setRunIntentActive(true);
  }, [hasActiveRun]);

  useEffect(() => {
    if (!runIntentActive) {
      return;
    }
    if (fixtureMode === "run-active") {
      return;
    }
    if (sending || aborting) {
      return;
    }
    if (streamStatus === "reconnecting") {
      return;
    }
    if (activeProject?.sessionStatus === "running") {
      return;
    }
    if (hasStreamingActivity) {
      return;
    }
    // Don't race against SSE busy handler — wait 3s after last busy before switching to send
    if (Date.now() - lastBusyReceivedAtRef.current < 3000) {
      return;
    }
    setRunIntentActive(false);
  }, [aborting, activeProject?.sessionStatus, fixtureMode, hasStreamingActivity, runIntentActive, sending, streamStatus]);

  useEffect(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [composerValue]);

  useEffect(() => {
    const activityEntries = renderedTimelineEntries.filter(
      (entry): entry is Extract<RenderedTimelineEntry, { kind: "activity" }> => entry.kind === "activity"
    );
    if (activityEntries.length === 0) {
      previousActivityEntriesRef.current = [];
      return;
    }

    setExpandedActivityEntries((current) => {
      const next: Record<string, boolean> = {};
      const previousEntries = previousActivityEntriesRef.current;
      const previousLastEntry = previousEntries[previousEntries.length - 1] ?? null;

      activityEntries.forEach((entry, index) => {
        if (entry.stateKey in current) {
          next[entry.stateKey] = current[entry.stateKey];
          return;
        }

        const overlappingPreviousEntry = previousEntries.find((previousEntry) =>
          previousEntry.childIds.some((childId) => entry.childIds.includes(childId))
        );
        if (overlappingPreviousEntry && overlappingPreviousEntry.stateKey in current) {
          next[entry.stateKey] = current[overlappingPreviousEntry.stateKey];
          return;
        }

        const isLastActivity = index === activityEntries.length - 1;
        if (
          isLastActivity &&
          previousLastEntry &&
          previousLastEntry.stateKey in current
        ) {
          next[entry.stateKey] = current[previousLastEntry.stateKey];
        }
      });

      previousActivityEntriesRef.current = activityEntries.map((entry) => ({
        stateKey: entry.stateKey,
        childIds: entry.childIds,
      }));
      return next;
    });
  }, [renderedTimelineEntries]);

  useEffect(() => {
    const shouldTick = stopFeedbackVisible || streamStatus === "reconnecting";
    if (!shouldTick) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setClockTick(Date.now());
    }, 500);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [stopFeedbackVisible, streamStatus]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!resizingSidebarRef.current || !shellRef.current || isMobileViewport) {
        return;
      }
      if (event.buttons !== 1) {
        resizingSidebarRef.current = false;
        return;
      }

      const rect = shellRef.current.getBoundingClientRect();
      const minSidebarWidth = 300;
      const minChatWidth = 420;
      const availableSidebarWidth = Math.max(0, rect.width - minChatWidth - 8);
      const effectiveMinSidebarWidth = Math.min(minSidebarWidth, availableSidebarWidth);
      const maxSidebarWidth = Math.max(effectiveMinSidebarWidth, Math.min(680, availableSidebarWidth));
      const nextWidth = event.clientX - rect.left;
      const clampedWidth = Math.min(maxSidebarWidth, Math.max(effectiveMinSidebarWidth, nextWidth));
      setDesktopSidebarWidth(clampedWidth);
    };

    const handlePointerUp = () => {
      resizingSidebarRef.current = false;
    };

    const handlePointerCancel = () => {
      resizingSidebarRef.current = false;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [isMobileViewport]);

  useEffect(() => {
    const shellElement = shellRef.current;
    if (!shellElement || isMobileViewport) {
      return;
    }

    const clampDesktopSidebarWidth = () => {
      const rect = shellElement.getBoundingClientRect();
      const minSidebarWidth = 300;
      const minChatWidth = 420;
      const availableSidebarWidth = Math.max(0, rect.width - minChatWidth - 8);
      const effectiveMinSidebarWidth = Math.min(minSidebarWidth, availableSidebarWidth);
      const maxSidebarWidth = Math.max(effectiveMinSidebarWidth, Math.min(680, availableSidebarWidth));
      setDesktopSidebarWidth((current) => Math.min(maxSidebarWidth, Math.max(effectiveMinSidebarWidth, current)));
    };

    clampDesktopSidebarWidth();

    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(clampDesktopSidebarWidth);
      resizeObserver.observe(shellElement);
      return () => {
        resizeObserver.disconnect();
      };
    }

    window.addEventListener("resize", clampDesktopSidebarWidth);
    return () => {
      window.removeEventListener("resize", clampDesktopSidebarWidth);
    };
  }, [isMobileViewport, sortedVisibleProjects.length]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(
        DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY,
        String(Math.round(desktopSidebarWidth))
      );
    } catch {
      // Ignore storage failures so resizing still works in restricted browsers.
    }
  }, [DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY, desktopSidebarWidth]);

  const schedulerHeartbeat = useMemo(
    () =>
      schedulerHeartbeatState({
        schedulerStatus,
        schedulerError,
        schedulerLoading,
      }),
    [schedulerStatus, schedulerError, schedulerLoading]
  );
  const timeFilteredTelemetryMarkers = useMemo(() => {
    const windowMs = markerTimeWindowMs(markerTimeWindow);
    if (windowMs === null) {
      return telemetryMarkers;
    }

    const cutoff = Date.now() - windowMs;
    return telemetryMarkers.filter((marker) => {
      const markerTime = new Date(marker.at).getTime();
      return Number.isFinite(markerTime) && markerTime >= cutoff;
    });
  }, [telemetryMarkers, markerTimeWindow]);
  const filteredTelemetryMarkers = useMemo(
    () => timeFilteredTelemetryMarkers.filter((marker) => markerCategoryFilter[marker.category]),
    [timeFilteredTelemetryMarkers, markerCategoryFilter]
  );
  const previewTelemetryMarkers = useMemo(
    () => filteredTelemetryMarkers.slice(Math.max(0, filteredTelemetryMarkers.length - 5)).reverse(),
    [filteredTelemetryMarkers]
  );
  const telemetryCategoryCounts = useMemo(() => {
    const counts: Record<TelemetryMarkerCategory, number> = {
      search: 0,
      project: 0,
      chat: 0,
      stream: 0,
      system: 0,
    };
    for (const marker of timeFilteredTelemetryMarkers) {
      counts[marker.category] += 1;
    }
    return counts;
  }, [timeFilteredTelemetryMarkers]);

  useEffect(() => {
    if (!isAuthenticated) {
      setSearchDebouncing(false);
      return;
    }

    if (projectSearchDebounceRef.current !== null) {
      window.clearTimeout(projectSearchDebounceRef.current);
      projectSearchDebounceRef.current = null;
    }

    if (!searchQuery) {
      setSearchProjects([]);
      setSearchHasMore(false);
      setSearchTotal(0);
      setSearchLoading(false);
      setSearchDebouncing(false);
      searchRequestIdRef.current += 1;
      return;
    }

    setSearchDebouncing(true);
    projectSearchDebounceRef.current = window.setTimeout(() => {
      projectSearchDebounceRef.current = null;
      setSearchDebouncing(false);
      void loadSearchProjects(searchQuery, 0, true);
    }, 220);

    return () => {
      if (projectSearchDebounceRef.current !== null) {
        window.clearTimeout(projectSearchDebounceRef.current);
        projectSearchDebounceRef.current = null;
      }
    };
  }, [isAuthenticated, searchQuery]);

  useEffect(() => {
    if (sortedVisibleProjects.length === 0) {
      setHighlightedProjectId(null);
      return;
    }

    if (isSearchMode && searchLoading && highlightedProjectId) {
      return;
    }

    if (highlightedProjectId && sortedVisibleProjects.some((project) => project.id === highlightedProjectId)) {
      return;
    }

    if (activeProjectId && sortedVisibleProjects.some((project) => project.id === activeProjectId)) {
      setHighlightedProjectId(activeProjectId);
      return;
    }

    setHighlightedProjectId(sortedVisibleProjects[0].id);
  }, [sortedVisibleProjects, highlightedProjectId, activeProjectId, isSearchMode, searchLoading]);

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      return target.isContentEditable;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!isAuthenticated) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const searchInput = getPreferredSearchInput();
        searchInput?.focus();
        searchInput?.select();
        addTelemetryMarker("search.focus.shortcut", { shortcut: "ctrl_or_meta+k" });
        return;
      }

      if (event.shiftKey && event.key.toLowerCase() === "s" && !isEditableTarget(event.target)) {
        event.preventDefault();
        focusSchedulerCard();
        addTelemetryMarker("scheduler.focus.shortcut", { shortcut: "shift+s" });
        return;
      }

      const isSearchFocused =
        document.activeElement === desktopProjectSearchInputRef.current ||
        document.activeElement === mobileProjectSearchInputRef.current;
      if (isSearchFocused && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        if (sortedVisibleProjects.length === 0) {
          return;
        }

        const currentIndex = highlightedProjectId
          ? sortedVisibleProjects.findIndex((project) => project.id === highlightedProjectId)
          : -1;

        if (event.key === "ArrowDown") {
          const nextIndex = Math.min(sortedVisibleProjects.length - 1, Math.max(0, currentIndex + 1));
          setHighlightedProjectId(sortedVisibleProjects[nextIndex].id);
          return;
        }

        const nextIndex = Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1);
        setHighlightedProjectId(sortedVisibleProjects[nextIndex].id);
        return;
      }

      if (isSearchFocused && event.key === "Enter") {
        event.preventDefault();
        if (highlightedProjectId) {
          void handleSelectProject(highlightedProjectId);
        }
        return;
      }

      if (isSearchFocused && event.key === "Escape") {
        event.preventDefault();
        setProjectSearch("");
        getPreferredSearchInput()?.blur();
        return;
      }

      if (event.key === "/" && !isEditableTarget(event.target)) {
        event.preventDefault();
        getPreferredSearchInput()?.focus();
        addTelemetryMarker("search.focus.shortcut", { shortcut: "/" });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isAuthenticated, sortedVisibleProjects, highlightedProjectId]);

  async function loadMessages(
    projectId: string,
    options?: { silent?: boolean; sessionId?: string }
  ) {
    const requestId = messageLoadRequestRef.current + 1;
    messageLoadRequestRef.current = requestId;
    messageRequestInFlightRef.current = true;
    captureVisibleTimelineAnchor();
    if (!options?.silent) {
      setMessagesLoading(true);
    }
    setProjectError(null);
    try {
      const sessionId = options && "sessionId" in options ? options.sessionId : activeSessionId ?? undefined;
      const messageResult = await fetchMessages(projectId, sessionId);
      if (requestId !== messageLoadRequestRef.current) {
        return;
      }
      if (!options?.sessionId) {
        setActiveSessionId(messageResult.sessionId);
        updateProjectSessionSelection(projectId, messageResult.sessionId);
      }
      setMessages(messageResult.messages);
      setTaskTimelineEvents(messageResult.timelineEvents ?? []);
      const resultSessionId = messageResult.sessionId;
      const lastAssistant = [...messageResult.messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        lastAssistantMessageIdBySessionRef.current = {
          ...lastAssistantMessageIdBySessionRef.current,
          [resultSessionId]: lastAssistant.id,
        };
      }
    } catch (error) {
      if (requestId !== messageLoadRequestRef.current) {
        return;
      }
      setProjectError(error instanceof Error ? error.message : "Failed to load messages");
      setMessages([]);
      setTaskTimelineEvents([]);
    } finally {
      messageRequestInFlightRef.current = false;
      const pendingProjectId = pendingMessageRefreshRef.current;
      if (pendingProjectId && pendingProjectId === projectId) {
        pendingMessageRefreshRef.current = null;
        void Promise.all([
          loadMessages(projectId, { silent: true }),
          loadProjectSessions(projectId, { silent: true }),
        ]);
      }
      if (requestId === messageLoadRequestRef.current) {
        if (!options?.silent) {
          setMessagesLoading(false);
        }
      }
    }
  }

async function loadDiff(projectId: string) {
  try {
    const diffResult = await fetchDiff(projectId);
    setDiffEntries(diffResult.diff);
  } catch {
    setDiffEntries([]);
  }
  try {
    const gitResult = await apiGitDiff(projectId);
    setGitDiffEntries(gitResult);
  } catch {
    setGitDiffEntries([]);
  }
}

  async function loadPendingApprovals(projectId: string) {
    try {
      const result = await fetchPendingApprovals(projectId);
      setPendingApprovals(result.approvals);
    } catch {
      setPendingApprovals([]);
    }
  }

  async function loadPendingQuestions(projectId: string) {
    try {
      const result = await fetchPendingQuestions(projectId);
      setPendingQuestions(result.questions);
      setQuestionDrafts((current) => {
        const next = { ...current };
        for (const question of result.questions) {
          if (!next[question.id]) {
            next[question.id] = buildInitialQuestionDraft(question);
          }
        }
        for (const key of Object.keys(next)) {
          if (!result.questions.some((question) => question.id === key)) {
            delete next[key];
          }
        }
        return next;
      });
    } catch {
      setPendingQuestions([]);
      setQuestionDrafts({});
    }
  }

  async function loadNotificationSettings() {
    try {
      const result = await fetchNotificationSettings();
      const nextEnabled = result.channel !== "off";
      setNotificationChannel(result.channel);
      setNtfyTopicUrl(result.ntfyTopicUrl);
      setNotificationsEnabled(nextEnabled);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(NOTIFICATION_PREFERENCE_KEY, nextEnabled ? "true" : "false");
      }
    } catch {
      setNotificationChannel("browser");
      setNtfyTopicUrl("");
    }
  }

  async function loadProjectDirectoryEntries(
    projectId: string,
    directory: string,
    reset = false
  ) {
    const generation = reset ? projectFileLoadGenerationRef.current + 1 : projectFileLoadGenerationRef.current;
    if (reset) {
      projectFileLoadGenerationRef.current = generation;
    }
    const normalizedDirectory = directory.trim();
    const requestKey = `${projectId}:${normalizedDirectory}`;
    if (projectFileDirectoryRequestsRef.current.has(requestKey)) {
      return;
    }
    projectFileDirectoryRequestsRef.current.add(requestKey);

    if (reset || normalizedDirectory.length === 0) {
      setProjectFilesLoading(true);
      setProjectFilesError(null);
    }
    setProjectFileLoadingDirs((current) =>
      current.includes(normalizedDirectory) ? current : [...current, normalizedDirectory]
    );

    try {
      const result = await fetchProjectDirectoryEntries(projectId, normalizedDirectory);
      if (generation !== projectFileLoadGenerationRef.current) {
        return;
      }
      setProjectFileEntries((current) => {
        const next = reset ? [] : [...current];
        const seen = new Set(next.map((entry) => `${entry.path}:${entry.isDir ? "d" : "f"}`));
        for (const entry of result.entries) {
          const key = `${entry.path}:${entry.isDir ? "d" : "f"}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          next.push(entry);
        }
        return next;
      });
      setProjectFilesTruncated((current) => current || result.truncated);
      setProjectFileLoadedDirs((current) =>
        current.includes(normalizedDirectory) ? current : [...current, normalizedDirectory]
      );
    } catch (error) {
      if (generation !== projectFileLoadGenerationRef.current) {
        return;
      }
      setProjectFilesError(
        error instanceof Error ? error.message : "Failed to load project files"
      );
      if (reset) {
        setProjectFileEntries([]);
        setProjectFilesTruncated(false);
        setProjectFileLoadedDirs([]);
      }
    } finally {
      projectFileDirectoryRequestsRef.current.delete(requestKey);
      setProjectFileLoadingDirs((current) =>
        current.filter((item) => item !== normalizedDirectory)
      );
      if (reset || normalizedDirectory.length === 0) {
        setProjectFilesLoading(false);
      }
    }
  }

  async function loadProjectFilePreview(projectId: string, path: string) {
    const requestId = projectFilePreviewRequestRef.current + 1;
    projectFilePreviewRequestRef.current = requestId;
    setProjectFileContentLoading(true);
    setProjectFileContentError(null);
    try {
      const result = await fetchProjectFileContent(projectId, path);
      if (requestId !== projectFilePreviewRequestRef.current) {
        return;
      }
      setSelectedProjectFileContent(result);
    } catch (error) {
      if (requestId !== projectFilePreviewRequestRef.current) {
        return;
      }
      setProjectFileContentError(error instanceof Error ? error.message : "Failed to load file preview");
      setSelectedProjectFileContent(null);
    } finally {
      if (requestId === projectFilePreviewRequestRef.current) {
        setProjectFileContentLoading(false);
      }
    }
  }

  async function loadTaskDetails(projectId: string, preferredTaskId?: string | null) {
    const requestId = taskLoadRequestRef.current + 1;
    taskLoadRequestRef.current = requestId;
    setTaskLoading(true);
    setTaskError(null);
    try {
      const taskResult = await fetchScheduledTask(projectId);
      if (requestId !== taskLoadRequestRef.current) {
        return;
      }
      const tasks = taskResult.tasks ?? (taskResult.task ? [taskResult.task] : []);
      const selectedTask =
        tasks.find((task) => task.id === preferredTaskId)
        ?? tasks.find((task) => task.id === scheduledTask?.id)
        ?? taskResult.task
        ?? tasks[0]
        ?? null;
      const runsResult = selectedTask
        ? await fetchScheduledTaskRuns(projectId, 20, selectedTask.id)
        : { runs: [] };
      if (requestId !== taskLoadRequestRef.current) {
        return;
      }
      setScheduledTasks(tasks);
      setScheduledTask(selectedTask);
      setScheduledRuns(runsResult.runs);

      if (selectedTask) {
        populateTaskForm(selectedTask);
      } else {
        resetTaskForm();
      }
    } catch (error) {
      if (requestId !== taskLoadRequestRef.current) {
        return;
      }
      setTaskError(error instanceof Error ? error.message : "Failed to load scheduled task");
      setScheduledTask(null);
      setScheduledTasks([]);
      setScheduledRuns([]);
    } finally {
      if (requestId === taskLoadRequestRef.current) {
        setTaskLoading(false);
      }
    }
  }

  async function loadSchedulerStatus() {
    setSchedulerLoading(true);
    setSchedulerError(null);
    try {
      const result = await fetchSchedulerStatus();
      setSchedulerStatus(result.scheduler);
    } catch (error) {
      setSchedulerError(error instanceof Error ? error.message : "Failed to load scheduler status");
      setSchedulerStatus(null);
    } finally {
      setSchedulerLoading(false);
    }
  }

  async function loadAvailableCommands() {
    try {
      const result = await fetchOpenCodeCommands();
      setAvailableCommands(result.commands);
    } catch {
      setAvailableCommands([]);
    }
  }

  async function loadProjectRuntime(projectId: string, options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;
    if (!silent) {
      setRuntimeLoading(true);
      setRuntimeError(null);
    }
    try {
      const result = await fetchProjectRuntime(projectId);
      setRuntimeModels(result.models);
      setRuntimeAgents(result.agents);
      setSelectedModel(result.selectedModel);
      setSelectedAgent(result.selectedAgent);
    } catch (error) {
      if (!silent) {
        setRuntimeError(error instanceof Error ? error.message : "Failed to load runtime controls");
      }
      setRuntimeModels([]);
      setRuntimeAgents([]);
      setSelectedModel(null);
      setSelectedAgent(null);
    } finally {
      if (!silent) {
        setRuntimeLoading(false);
      }
    }
  }

  async function handleReloadRuntime() {
    if (!activeProjectId) return;
    if (reloadMessageTimeoutRef.current !== null) {
      window.clearTimeout(reloadMessageTimeoutRef.current);
      reloadMessageTimeoutRef.current = null;
    }
    setReloading(true);
    setReloadMessage(null);
    try {
      await loadProjectRuntime(activeProjectId);
      setReloadMessage("Config reloaded ✓");
    } catch {
      setReloadMessage("Reload failed");
    } finally {
      setReloading(false);
      reloadMessageTimeoutRef.current = window.setTimeout(() => {
        setReloadMessage(null);
        reloadMessageTimeoutRef.current = null;
      }, 3000);
    }
  }

  useEffect(() => {
    return () => {
      if (reloadMessageTimeoutRef.current !== null) {
        window.clearTimeout(reloadMessageTimeoutRef.current);
      }
    };
  }, []);

  function updateProjectSessionSelection(projectId: string, sessionId: string | null) {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId ? { ...project, lastSessionId: sessionId } : project
      )
    );
    setSearchProjects((current) =>
      current.map((project) =>
        project.id === projectId ? { ...project, lastSessionId: sessionId } : project
      )
    );
  }

  async function loadProjectSessions(projectId: string, options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;
    const requestId = sessionLoadRequestRef.current + 1;
    sessionLoadRequestRef.current = requestId;
    if (!silent) {
      setSessionLoading(true);
      setSessionError(null);
    }
    try {
      const result = await fetchProjectSessions(projectId);
      if (requestId !== sessionLoadRequestRef.current) {
        return;
      }
      setProjectSessions(result.sessions);
      const resolvedActiveSessionId = result.activeSessionId ?? activeSessionId ?? null;
      if (!silent) {
        setActiveSessionId(resolvedActiveSessionId);
        updateProjectSessionSelection(projectId, resolvedActiveSessionId);
      }
    } catch (error) {
      if (requestId !== sessionLoadRequestRef.current) {
        return;
      }
      if (!silent) {
        setSessionError(error instanceof Error ? error.message : "Failed to load sessions");
        setProjectSessions([]);
        setActiveSessionId(null);
      }
    } finally {
      if (!silent && requestId === sessionLoadRequestRef.current) {
        setSessionLoading(false);
      }
    }
  }

  async function saveProjectRuntimeSelection(input: {
    model: string | null;
    agent: string | null;
  }) {
    if (!activeProjectId) {
      return;
    }
    setRuntimeSaving(true);
    setRuntimeError(null);
    try {
      const result = await updateProjectRuntime(activeProjectId, input);
      setSelectedModel(result.selectedModel);
      setSelectedAgent(result.selectedAgent);
      addTelemetryMarker("project.runtime.update", {
        projectId: activeProjectId,
        model: result.selectedModel,
        agent: result.selectedAgent,
      });
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Failed to save runtime controls");
      await loadProjectRuntime(activeProjectId);
    } finally {
      setRuntimeSaving(false);
    }
  }

  async function handleSaveTask() {
    if (!activeProjectId) {
      return;
    }

    setTaskSaving(true);
    setTaskError(null);
    try {
      const [onceDatePart, onceTimePart] = taskOnceInput.split("T");
      const response = await saveScheduledTask(activeProjectId, {
        id: scheduledTask?.id,
        name: taskNameInput,
        description: taskDescriptionInput,
        instruction: taskInstructionInput,
        taskType: taskTypeInput,
        cronExpression: taskCronInput,
        onceRunAt: onceDatePart
          ? toIsoInTimezone(onceDatePart, onceTimePart ?? "00:00", taskTimezoneInput)
          : null,
        intervalMinutes: taskIntervalInput,
        startsAt: toIsoInTimezone(taskStartsDateInput, taskStartsTimeInput, taskTimezoneInput),
        endsAt: toIsoInTimezone(taskEndsDateInput, taskEndsTimeInput, taskTimezoneInput),
        timezone: taskTimezoneInput,
        model: taskModelInput || null,
        agent: taskAgentInput || null,
        maxRuns: taskMaxRunsInput ? Number(taskMaxRunsInput) : null,
        runTimeoutMinutes: taskTimeoutInput ? Number(taskTimeoutInput) : null,
        retryCount: Number(taskRetryCountInput || "0"),
        retryBackoffMinutes: Number(taskRetryBackoffInput || "5"),
        heartbeatEnabled: taskHeartbeatInput,
        goalDefinition: taskGoalInput || null,
        autoDisableOnGoalMet: taskAutoDisableOnGoalMetInput,
        notificationUrl: taskNotificationUrlInput || null,
        enabled: taskEnabledInput,
      });
      setScheduledTask(response.task);
      setScheduledTasks(response.tasks ?? []);
      await loadTaskDetails(activeProjectId, response.task.id);
      await refreshProjectsAndStatus(activeProjectId);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Failed to save task");
    } finally {
      setTaskSaving(false);
    }
  }

  async function handleRunTaskNow() {
    if (!activeProjectId) {
      return;
    }

    setTaskRunning(true);
    setTaskError(null);
    try {
      const response = await runScheduledTaskNow(activeProjectId, scheduledTask?.id);
      setScheduledTask(response.task);
      await loadTaskDetails(activeProjectId, response.task.id);
      await refreshProjectsAndStatus(activeProjectId);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Failed to run task now");
    } finally {
      setTaskRunning(false);
    }
  }

  async function handleDeleteTask() {
    if (!activeProjectId) {
      return;
    }

    setTaskDeleting(true);
    setTaskError(null);
    try {
      await deleteScheduledTask(activeProjectId, scheduledTask?.id);
      setScheduledTask(null);
      setScheduledRuns([]);
      setTaskTimelineEvents([]);
      resetTaskForm();
      await loadTaskDetails(activeProjectId);
      await refreshProjectsAndStatus(activeProjectId);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Failed to delete task");
    } finally {
      setTaskDeleting(false);
    }
  }

  async function handleSelectTask(task: ScheduledTask) {
    populateTaskForm(task);
    if (!activeProjectId) {
      return;
    }
    try {
      const result = await fetchScheduledTaskRuns(activeProjectId, 20, task.id);
      setScheduledRuns(result.runs);
    } catch {
      setScheduledRuns([]);
    }
  }

  async function handlePreviewTaskSchedule() {
    if (!activeProjectId) {
      return;
    }
    setTaskError(null);
    try {
      const [onceDatePart, onceTimePart] = taskOnceInput.split("T");
      const result = await previewScheduledTask(activeProjectId, {
        taskType: taskTypeInput,
        cronExpression: taskCronInput,
        onceRunAt: onceDatePart
          ? toIsoInTimezone(onceDatePart, onceTimePart ?? "00:00", taskTimezoneInput)
          : null,
        intervalMinutes: taskIntervalInput,
        timezone: taskTimezoneInput,
      });
      setTaskPreviewRuns(result.runs);
    } catch (error) {
      setTaskPreviewRuns([]);
      setTaskError(error instanceof Error ? error.message : "Failed to preview schedule");
    }
  }

  async function handlePauseResumeTask() {
    if (!activeProjectId || !scheduledTask) {
      return;
    }
    setTaskSaving(true);
    setTaskError(null);
    try {
      const result = scheduledTask.enabled
        ? await pauseScheduledTask(activeProjectId, scheduledTask.id)
        : await resumeScheduledTask(activeProjectId, scheduledTask.id);
      populateTaskForm(result.task);
      await loadTaskDetails(activeProjectId, result.task.id);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Failed to update task state");
    } finally {
      setTaskSaving(false);
    }
  }

  async function loadProjectPrd(projectId: string) {
    setPrdLoading(true);
    setPrdError(null);
    try {
      const result = await fetchProjectPrd(projectId);
      setPrdData(result.prd);
    } catch (error) {
      setPrdError(error instanceof Error ? error.message : "Failed to load PRD");
      setPrdData(null);
    } finally {
      setPrdLoading(false);
    }
  }

  async function handleInitPrd() {
    if (!activeProjectId) {
      return;
    }
    setPrdInitializing(true);
    setPrdError(null);
    try {
      const result = await initProjectPrd(activeProjectId);
      setPrdData(result.prd);
    } catch (error) {
      setPrdError(error instanceof Error ? error.message : "Failed to create PRD");
    } finally {
      setPrdInitializing(false);
    }
  }

  function handleCreateRalphTask() {
    resetTaskForm();
    setTaskNameInput("Ralph Loop");
    setTaskDescriptionInput("Autonomous PRD agent: completes user stories one at a time.");
    setTaskTypeInput("goal");
    setTaskInstructionInput(RALPH_TASK_INSTRUCTION);
    setTaskGoalInput(RALPH_GOAL_DEFINITION);
    setTaskIntervalInput(15);
    setTaskEnabledInput(true);
    setTaskAutoDisableOnGoalMetInput(true);
    setTaskHeartbeatInput(false);
  }

  function scheduleStreamRefresh(projectId: string) {
    if (refreshDebounceRef.current !== null) {
      window.clearTimeout(refreshDebounceRef.current);
    }

    refreshDebounceRef.current = window.setTimeout(() => {
      if (messageRequestInFlightRef.current) {
        pendingMessageRefreshRef.current = projectId;
      } else {
        void Promise.all([
          loadMessages(projectId, { silent: true }),
          loadProjectSessions(projectId, { silent: true }),
          loadPendingQuestions(projectId),
        ]);
      }
      refreshDebounceRef.current = null;
    }, 700);
  }

  useEffect(() => {
    if (!isAuthenticated || !activeProjectId) {
      setStreamStatus("idle");
      setRunIntentActive(false);
      setReconnectStartedAtMs(null);
      setReconnectAttemptCount(0);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (streamReconnectTimerRef.current !== null) {
        window.clearTimeout(streamReconnectTimerRef.current);
        streamReconnectTimerRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      setStreamStatus("connecting");
      const stream = new EventSource(`/api/projects/${activeProjectId}/stream`, {
        withCredentials: true,
      });
      eventSourceRef.current = stream;

      stream.onopen = () => {
        streamReconnectAttemptRef.current = 0;
        setStreamStatus("live");
        setReconnectStartedAtMs(null);
        setReconnectAttemptCount(0);
        addTelemetryMarker("stream.chat.open", { projectId: activeProjectId });
      };

      stream.onmessage = (event) => {
        // Reset silence timeout — any event means the connection is alive
        if (silenceTimerRef.current !== null) {
          window.clearTimeout(silenceTimerRef.current);
        }
        silenceTimerRef.current = window.setTimeout(() => {
          silenceTimerRef.current = null;
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          setStreamStatus("reconnecting");
          setReconnectStartedAtMs(Date.now());
        }, 30000);

        // Parse backend wrapper: data: {"sessionId": "...", "event": ["event: ...", "data: ..."]}
        const eventLines = ((): string[] => {
          try {
            const wrapper = JSON.parse(event.data) as { event?: string[] };
            return Array.isArray(wrapper.event) ? wrapper.event : [];
          } catch {
            return [];
          }
        })();

        if (eventLines.length === 0) return;

        const classification = classifyRawEvent(eventLines);
        if (classification.isHeartbeat) return;

        // --- Approvals ---
        const parsed = parseApprovalFromEventLines(eventLines);
        if (parsed.request) {
          setPendingApprovals((current) => {
            if (current.some((item) => item.permissionId === parsed.request?.permissionId)) {
              return current;
            }
            return [...current, parsed.request!];
          });
        }
        if (parsed.resolvedPermissionId) {
          setPendingApprovals((current) =>
            current.filter((item) => item.permissionId !== parsed.resolvedPermissionId)
          );
        }

        // --- Questions ---
        const parsedQuestion = parseQuestionFromEventLines(eventLines);
        if (parsedQuestion.request && parsedQuestion.request.sessionID === activeSessionId) {
          setPendingQuestions((current) => {
            if (current.some((item) => item.id === parsedQuestion.request?.id)) {
              return current;
            }
            return [...current, parsedQuestion.request!];
          });
          setQuestionDrafts((current) => {
            if (!parsedQuestion.request || current[parsedQuestion.request.id]) {
              return current;
            }
            return {
              ...current,
              [parsedQuestion.request.id]: buildInitialQuestionDraft(parsedQuestion.request),
            };
          });
        }
        if (parsedQuestion.resolvedQuestionId) {
          setPendingQuestions((current) => removeQuestionFromList(current, parsedQuestion.resolvedQuestionId!));
          setQuestionDrafts((current) => {
            const next = { ...current };
            delete next[parsedQuestion.resolvedQuestionId!];
            return next;
          });
        }

        // --- Text delta ---
        if (classification.hasPartDelta) {
          const partData = extractMessagePartText(eventLines);
          if (partData && partData.text != null && partData.partID && (partData.messageID || activeSessionId)) {
            const targetMsgId = partData.messageID || lastAssistantMessageIdBySessionRef.current[activeSessionId ?? ""];
            if (!targetMsgId) return;
            setMessages((current) => {
              const msgIndex = current.findIndex((m) => m.id === targetMsgId);
              if (msgIndex < 0) {
                return [...current, {
                  id: targetMsgId,
                  role: "assistant",
                  createdAt: new Date().toISOString(),
                  text: partData.text || "",
                  parts: partData.text ? [{ type: "text", id: partData.partID, text: partData.text }] : [],
                }];
              }
              const existing = current[msgIndex];
              const updatedParts = [...existing.parts];
              const textPartIndex = updatedParts.findIndex(
                (p) => typeof p === "object" && p !== null && p.type === "text" && p.id === partData.partID
              );
              if (textPartIndex >= 0) {
                const existingText = (updatedParts[textPartIndex] as Record<string, unknown>).text as string || "";
                updatedParts[textPartIndex] = { ...updatedParts[textPartIndex], text: existingText + (partData.text || "") };
              } else {
                updatedParts.push({ type: "text", id: partData.partID, text: partData.text });
              }
              const allText = updatedParts
                .filter((p) => typeof p === "object" && p !== null && p.type === "text")
                .map((p) => (p as Record<string, string>).text || "")
                .join("\n").trim();
              const next = [...current];
              next[msgIndex] = { ...existing, text: allText, parts: updatedParts };
              return next;
            });
          }
        }

        // --- Part update ---
        if (classification.hasPartUpdate) {
          const extracted = extractPartFromEvent(eventLines);
          if (extracted && extracted.part) {
            const part = extracted.part;
            const msgID = typeof part.messageID === "string" ? part.messageID : null;
            const partID = typeof part.id === "string" ? part.id : null;
            if (msgID && partID) {
              setMessages((current) => {
                const msgIndex = current.findIndex((m) => m.id === msgID);
                if (msgIndex < 0) return current;
                const existing = current[msgIndex];
                const updatedParts = [...existing.parts];
                const existingIdx = updatedParts.findIndex(
                  (p) => typeof p === "object" && p !== null && (p as Record<string, unknown>).id === partID
                );
                if (existingIdx >= 0) {
                  updatedParts[existingIdx] = part as unknown as ChatMessage["parts"][number];
                } else {
                  updatedParts.push(part as unknown as ChatMessage["parts"][number]);
                }
                const next = [...current];
                next[msgIndex] = { ...existing, parts: updatedParts };
                return next;
              });
            }
          }
        }

        // --- Part remove ---
        if (classification.hasPartRemove) {
          const extracted = extractPartRemovalFromEvent(eventLines);
          if (extracted?.messageID && extracted.partID) {
            setMessages((current) => {
              const msgIndex = current.findIndex((m) => m.id === extracted.messageID);
              if (msgIndex < 0) return current;
              const existing = current[msgIndex];
              const isPartToRemove = (part: ChatMessage["parts"][number]) =>
                typeof part === "object" && part !== null && (part as Record<string, unknown>).id === extracted.partID;
              const updatedParts = existing.parts.filter((part) => !isPartToRemove(part));
              if (updatedParts.length === existing.parts.length) return current;
              const next = [...current];
              next[msgIndex] = {
                ...existing,
                parts: updatedParts,
                text: updatedParts
                  .filter((p) => typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text")
                  .map((p) => (p as Record<string, string>).text || "")
                  .join("\n").trim(),
              };
              return next;
            });
          }
        }

        // --- Message update ---
        if (classification.hasMessageUpdate) {
          const info = extractMessageFromEvent(eventLines);
          if (info && typeof info.id === "string" && typeof info.role === "string") {
            const infoId = info.id;
            const infoRole = info.role as ChatMessage["role"];
            setMessages((current) => {
              const existingIdx = current.findIndex((m) => m.id === infoId);
              if (existingIdx >= 0) {
                // Don't update text or parts — message.part.updated/delta already built them
                return current;
              }
              const msg = {
                id: infoId,
                role: infoRole,
                text: typeof info.text === "string" ? info.text : "",
                createdAt: typeof info.time === "object" && info.time
                  ? new Date((info.time as Record<string, unknown>).created as number).toISOString()
                  : new Date().toISOString(),
                parts: Array.isArray(info.parts) ? info.parts as ChatMessage["parts"] : [],
              };
              return [...current, msg];
            });
          }
        }

        // --- Diff update ---
        if (classification.hasDiffUpdate) {
          const diffData = extractDiffFromEvent(eventLines);
          if (diffData) {
            setDiffEntries(diffData.diff as unknown as SessionDiffEntry[]);
          }
        }

        // --- Session status ---
        if (classification.hasSessionUpdate) {
          const statusData = extractSessionStatusFromEvent(eventLines);
          if (statusData && statusData.status) {
            const statusType = String((statusData.status as Record<string, unknown>).type || "");
            if (statusType === "idle") {
              // Debounce 2s before switching to send + soft refresh
              // Prevents toggling between messages in plan mode
              if (idleDebounceTimerRef.current !== null) {
                window.clearTimeout(idleDebounceTimerRef.current);
              }
              idleDebounceTimerRef.current = window.setTimeout(() => {
                idleDebounceTimerRef.current = null;
                setRunIntentActive(false);
                if (activeProjectId && activeSessionId) {
                  void loadMessages(activeProjectId, { silent: true, sessionId: activeSessionId });
                }
              }, 2000);
            } else if (statusType === "busy") {
              lastBusyReceivedAtRef.current = Date.now();
              // Cancel idle debounce if activity resumes
              if (idleDebounceTimerRef.current !== null) {
                window.clearTimeout(idleDebounceTimerRef.current);
                idleDebounceTimerRef.current = null;
              }
              setRunIntentActive(true);
            }
          }
        }

        const needsFullRefresh = classification.hasCompactionUpdate || classification.hasMessageDelete;
        if (needsFullRefresh) {
          scheduleStreamRefresh(activeProjectId);
        }
      };

      stream.onerror = () => {
        if (cancelled) return;

        stream.close();
        if (eventSourceRef.current === stream) {
          eventSourceRef.current = null;
        }
        setStreamStatus("reconnecting");
        setReconnectStartedAtMs((current) => current ?? Date.now());
        addTelemetryMarker("stream.chat.error", { projectId: activeProjectId });

        const attempt = streamReconnectAttemptRef.current;
        const delay = nextReconnectDelayMs(attempt);
        setReconnectAttemptCount(attempt + 1);
        streamReconnectAttemptRef.current = Math.min(attempt + 1, 5);
        streamReconnectTimerRef.current = window.setTimeout(() => {
          streamReconnectTimerRef.current = null;
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (streamReconnectTimerRef.current !== null) {
        window.clearTimeout(streamReconnectTimerRef.current);
        streamReconnectTimerRef.current = null;
      }
      if (idleDebounceTimerRef.current !== null) {
        window.clearTimeout(idleDebounceTimerRef.current);
        idleDebounceTimerRef.current = null;
      }
      if (silenceTimerRef.current !== null) {
        window.clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [isAuthenticated, activeProjectId, activeSessionId]);

  useEffect(() => {
    // Intentionally disable aggressive project SSE sync because some OpenCode servers
    // emit frequent project events, which causes constant UI refresh loops.
  }, [isAuthenticated]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setAppInstalled(true);
      setInstallingApp(false);
      setDeferredInstallPrompt(null);
    };

    const displayModeQuery = window.matchMedia("(display-mode: standalone)");
    const handleDisplayModeChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setAppInstalled(true);
        setDeferredInstallPrompt(null);
      }
    };

    if (displayModeQuery.matches) {
      setAppInstalled(true);
      setDeferredInstallPrompt(null);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    displayModeQuery.addEventListener("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      displayModeQuery.removeEventListener("change", handleDisplayModeChange);
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !activeProjectId) {
      taskLoadRequestRef.current += 1;
      sessionLoadRequestRef.current += 1;
      projectFilePreviewRequestRef.current += 1;
      projectFileLoadGenerationRef.current += 1;
      setScheduledTask(null);
      setScheduledRuns([]);
      setTaskTimelineEvents([]);
      setTaskInstructionInput("");
      setTaskIntervalInput(15);
      setTaskEnabledInput(true);
      setTaskError(null);
      setTaskLoading(false);
      setRuntimeModels([]);
      setRuntimeAgents([]);
      setSelectedModel(null);
      setSelectedAgent(null);
      setRuntimeError(null);
      setRuntimeLoading(false);
      setProjectSessions([]);
      setActiveSessionId(null);
      setSessionError(null);
      setSessionLoading(false);
      setPendingQuestions([]);
      setQuestionDrafts({});
      setRespondingQuestionId(null);
      setProjectFileEntries([]);
      setProjectFilesTruncated(false);
      setProjectFilesError(null);
      setProjectFilesLoading(false);
      setProjectFileLoadedDirs([]);
      setProjectFileLoadingDirs([]);
      setProjectFileQuery("");
      setSelectedProjectFilePath(null);
      setSelectedProjectFileContent(null);
      setProjectFileContentError(null);
      setProjectFileContentLoading(false);
      setPrdData(null);
      setPrdError(null);
      return;
    }

    void loadTaskDetails(activeProjectId);
    void loadProjectRuntime(activeProjectId);
    void loadProjectSessions(activeProjectId);
    void loadProjectPrd(activeProjectId);
    void loadPendingQuestions(activeProjectId);
    projectFileDirectoryRequestsRef.current.clear();
    projectFileLoadGenerationRef.current += 1;
    setProjectFileEntries([]);
    setProjectFilesTruncated(false);
    setProjectFileLoadedDirs([]);
    setProjectFileLoadingDirs([]);
    void loadProjectDirectoryEntries(activeProjectId, "", true);
    setSelectedProjectFilePath(null);
    setSelectedProjectFileContent(null);
    setProjectFileContentError(null);
    setProjectFileContentLoading(false);
  }, [isAuthenticated, activeProjectId]);

  useEffect(() => {
    if (!isAuthenticated || !activeProjectId) {
      return;
    }

    const refreshSessions = () => {
      void loadProjectSessions(activeProjectId, { silent: true });
    };

    const intervalId = window.setInterval(refreshSessions, SESSION_LIST_REFRESH_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshSessions();
      }
    };

    window.addEventListener("focus", refreshSessions);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshSessions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated, activeProjectId, SESSION_LIST_REFRESH_MS]);

  useEffect(() => {
    if (!isAuthenticated || !activeProjectId) {
      return;
    }

    const refreshModels = () => {
      void loadProjectRuntime(activeProjectId, { silent: true });
    };

    const intervalId = window.setInterval(refreshModels, MODEL_LIST_REFRESH_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshModels();
      }
    };

    window.addEventListener("focus", refreshModels);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshModels);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated, activeProjectId, MODEL_LIST_REFRESH_MS]);

  useEffect(() => {
    if (!activeProjectId && activeMainView !== "chat") {
      setActiveMainView("chat");
    }
  }, [activeMainView, activeProjectId]);

  useEffect(() => {
    return () => {
      if (schedulerCardPulseTimerRef.current !== null) {
        window.clearTimeout(schedulerCardPulseTimerRef.current);
        schedulerCardPulseTimerRef.current = null;
      }
      cleanupMediaRecorder();
      stopSpeakingAudio();
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setSchedulerStatus(null);
      setSchedulerError(null);
      setSchedulerLoading(false);
      setAvailableCommands([]);
      return;
    }

    void loadSchedulerStatus();
    void loadAvailableCommands();
    const intervalId = window.setInterval(() => {
      void loadSchedulerStatus();
    }, 45000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void handleSyncProjects();
    }, 90000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isAuthenticated, activeProjectId, activeSessionId]);

  useEffect(() => {
    const body = chatBodyRef.current;
    if (!body) {
      return;
    }

    const latestEntryId = timelineEntries[timelineEntries.length - 1]?.id ?? null;
    if (!latestEntryId) {
      setUnreadEntryId(null);
      return;
    }

    const previousChatKey = previousChatKeyRef.current;
    const openingChat = activeChatKey !== previousChatKey;
    previousChatKeyRef.current = activeChatKey;

    if (!activeChatKey) {
      setUnreadEntryId(null);
      return;
    }

    const lastReadEntryId = latestReadEntryIdByChatRef.current[activeChatKey] ?? null;
    const lastReadIndex = lastReadEntryId
      ? timelineEntries.findIndex((entry) => entry.id === lastReadEntryId)
      : -1;
    const firstUnreadEntry =
      lastReadIndex >= 0 ? timelineEntries[lastReadIndex + 1] ?? null : timelineEntries[timelineEntries.length - 1] ?? null;

    if (openingChat) {
      pendingOpenScrollRef.current = firstUnreadEntry?.id ?? latestEntryId;
      setUnreadEntryId(firstUnreadEntry?.id ?? null);
      return;
    }

    if (isChatNearBottom) {
      latestReadEntryIdByChatRef.current[activeChatKey] = latestEntryId;
      setUnreadEntryId(null);
      return;
    }

    setUnreadEntryId(firstUnreadEntry?.id ?? null);
  }, [activeChatKey, isChatNearBottom, timelineEntries]);

  useEffect(() => {
    if (!activeChatKey) {
      pendingOpenScrollRef.current = null;
      return;
    }

    const targetEntryId = pendingOpenScrollRef.current;
    if (!targetEntryId) {
      return;
    }

    const entry = timelineEntryRefs.current[targetEntryId] ?? null;
    if (!entry) {
      return;
    }

    scrollEntryIntoView(chatBodyRef.current, entry, "auto");
    pendingOpenScrollRef.current = null;
  }, [activeChatKey, timelineEntries]);

  useLayoutEffect(() => {
    const body = chatBodyRef.current;
    if (!body) {
      pendingScrollAnchorRef.current = null;
      return;
    }

    if (isChatNearBottom) {
      body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
      return;
    }

    const pendingAnchor = pendingScrollAnchorRef.current;
    if (!pendingAnchor) {
      return;
    }

    const entry = timelineEntryRefs.current[pendingAnchor.entryId];
    if (!entry) {
      pendingScrollAnchorRef.current = null;
      return;
    }

    const bodyTop = body.getBoundingClientRect().top;
    const nextTop = entry.getBoundingClientRect().top - bodyTop;
    body.scrollTop += nextTop - pendingAnchor.top;
    pendingScrollAnchorRef.current = null;
  }, [isChatNearBottom, renderedTimelineEntries]);

  useEffect(() => {
    const body = chatBodyRef.current;
    if (pendingQuestions.length > 0 && prevQuestionCountRef.current === 0 && body) {
      const card = body.querySelector(".question-card");
      if (card) {
        const cardRect = card.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const offsetTop = cardRect.top - bodyRect.top + body.scrollTop - 24;
        body.scrollTo({ top: Math.max(0, offsetTop), behavior: "auto" });
      }
      const q = pendingQuestions[pendingQuestions.length - 1];
      const text = q.questions?.[0]?.question || "Agent has a question for you";
      const notify = notificationsEnabled && (notificationChannel === "browser" || notificationChannel === "both");
      if (notify && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification(activeProject?.name || "Agent question", { body: text, tag: `question:${q.id}` });
        n.onclick = () => { window.focus(); n.close(); };
      }
      const ntfy = notificationsEnabled && (notificationChannel === "ntfy" || notificationChannel === "both") && ntfyTopicUrl.trim();
      if (ntfy) {
        void sendNtfyNotification({ title: activeProject?.name || "Agent question", message: text, ntfyTopicUrl: ntfyTopicUrl.trim() }).catch(() => {});
      }
    }
    prevQuestionCountRef.current = pendingQuestions.length;
  }, [pendingQuestions.length, notificationsEnabled, notificationChannel, ntfyTopicUrl, activeProject?.name]);

  useEffect(() => {
    if (pendingApprovals.length > 0 && prevApprovalCountRef.current === 0) {
      const a = pendingApprovals[pendingApprovals.length - 1];
      const text = a.title || a.details || "Agent needs your permission";
      const notify = notificationsEnabled && (notificationChannel === "browser" || notificationChannel === "both");
      if (notify && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification(activeProject?.name || "Permission needed", { body: text, tag: `approval:${a.permissionId}` });
        n.onclick = () => { window.focus(); n.close(); };
      }
      const ntfy = notificationsEnabled && (notificationChannel === "ntfy" || notificationChannel === "both") && ntfyTopicUrl.trim();
      if (ntfy) {
        void sendNtfyNotification({ title: activeProject?.name || "Permission needed", message: text, ntfyTopicUrl: ntfyTopicUrl.trim() }).catch(() => {});
      }
    }
    prevApprovalCountRef.current = pendingApprovals.length;
  }, [pendingApprovals.length, notificationsEnabled, notificationChannel, ntfyTopicUrl, activeProject?.name]);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  useEffect(() => {
    if (!activeChatKey || typeof document === "undefined") {
      return;
    }

    const latestFinalAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim());
    if (!latestFinalAssistantMessage) {
      return;
    }

    const hasTrackedFinalReply = Object.prototype.hasOwnProperty.call(
      lastFinalAssistantMessageIdByChatRef.current,
      activeChatKey
    );
    const previousMessageId = hasTrackedFinalReply
      ? lastFinalAssistantMessageIdByChatRef.current[activeChatKey] ?? null
      : null;
    const awaitingFirstFinalReply =
      awaitingFinalReplyNotificationByChatRef.current[activeChatKey] === true;

    if (!hasTrackedFinalReply && !awaitingFirstFinalReply) {
      lastFinalAssistantMessageIdByChatRef.current[activeChatKey] = latestFinalAssistantMessage.id;
      return;
    }

    const isNewFinalReply = previousMessageId !== latestFinalAssistantMessage.id;
    const shouldNotifyBrowser =
      notificationsEnabled &&
      isNewFinalReply &&
      (notificationChannel === "browser" || notificationChannel === "both") &&
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted";
    const shouldNotifyNtfy =
      notificationsEnabled &&
      isNewFinalReply &&
      (notificationChannel === "ntfy" || notificationChannel === "both") &&
      ntfyTopicUrl.trim().length > 0;

    if (isNewFinalReply) {
      if (notificationDebounceTimerRef.current !== null) {
        clearTimeout(notificationDebounceTimerRef.current);
      }

      pendingNotificationDataRef.current = {
        chatKey: activeChatKey,
        projectName: activeProject?.name || "Agent reply",
        messageText: latestFinalAssistantMessage.text.trim().slice(0, 180),
        messageId: latestFinalAssistantMessage.id,
        shouldNotifyBrowser,
        shouldNotifyNtfy,
      };

      notificationDebounceTimerRef.current = window.setTimeout(() => {
        notificationDebounceTimerRef.current = null;
        const data = pendingNotificationDataRef.current;
        if (!data) return;

        if (data.shouldNotifyBrowser) {
          const notification = new Notification(data.projectName, {
            body: data.messageText,
            tag: `${data.chatKey}:${data.messageId}`,
          });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }

        if (data.shouldNotifyNtfy) {
          void sendNtfyNotification({
            title: data.projectName,
            message: data.messageText,
            ntfyTopicUrl: ntfyTopicUrl.trim(),
          }).catch(() => {
            // Keep chat rendering resilient if background notification delivery fails.
          });
        }

        awaitingFinalReplyNotificationByChatRef.current[data.chatKey] = false;
        lastFinalAssistantMessageIdByChatRef.current[data.chatKey] = data.messageId;
        pendingNotificationDataRef.current = null;
      }, 2500);
    }

    return () => {
      if (notificationDebounceTimerRef.current !== null) {
        clearTimeout(notificationDebounceTimerRef.current);
        notificationDebounceTimerRef.current = null;
      }
    };
  }, [activeChatKey, activeProject?.name, messages, notificationChannel, notificationsEnabled, ntfyTopicUrl]);

  useEffect(() => {
    if (!activeProjectId || messages.length === 0) {
      return;
    }

    if (firstMessageMarkerProjectsRef.current.has(activeProjectId)) {
      return;
    }

    firstMessageMarkerProjectsRef.current.add(activeProjectId);
    addTelemetryMarker("chat.first_message_render", {
      projectId: activeProjectId,
      messageCount: messages.length,
      firstMessageId: messages[0]?.id ?? null,
    });
  }, [activeProjectId, messages]);

  async function handleLogin(password: string) {
    setAuthError(null);
    setAuthLoading(true);
    try {
      await login(password);
      setIsAuthenticated(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Failed to sign in");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogout() {
    await logout();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (streamReconnectTimerRef.current !== null) {
      window.clearTimeout(streamReconnectTimerRef.current);
      streamReconnectTimerRef.current = null;
    }
    if (refreshDebounceRef.current !== null) {
      window.clearTimeout(refreshDebounceRef.current);
      refreshDebounceRef.current = null;
    }
    if (projectSearchDebounceRef.current !== null) {
      window.clearTimeout(projectSearchDebounceRef.current);
      projectSearchDebounceRef.current = null;
    }
    if (schedulerCardPulseTimerRef.current !== null) {
      window.clearTimeout(schedulerCardPulseTimerRef.current);
      schedulerCardPulseTimerRef.current = null;
    }
    cleanupMediaRecorder();
    stopSpeakingAudio();
    searchRequestIdRef.current += 1;
    setIsAuthenticated(false);
    setProjects([]);
    setProjectsHasMore(false);
    setProjectsTotal(0);
    setSearchProjects([]);
    setSearchHasMore(false);
    setSearchTotal(0);
    setSearchLoading(false);
    setSearchDebouncing(false);
    setBasePageLoads(0);
    setSearchPageLoads(0);
    setLastBaseLoadMs(null);
    setLastSearchLoadMs(null);
    setLastSearchQuery("");
    setTelemetryMarkers([]);
    setMarkerCategoryFilter({
      search: true,
      project: true,
      chat: true,
      stream: true,
      system: true,
    });
    setMarkerTimeWindow("all");
    firstMessageMarkerProjectsRef.current = new Set();
    timelineEntryRefs.current = {};
    latestReadEntryIdByChatRef.current = {};
    previousChatKeyRef.current = null;
    pendingOpenScrollRef.current = null;
    messageLoadRequestRef.current += 1;
    taskLoadRequestRef.current += 1;
    sessionLoadRequestRef.current += 1;
    projectFilePreviewRequestRef.current += 1;
    setActiveProjectId(null);
    setActiveSessionId(null);
    setScheduledTask(null);
    setScheduledRuns([]);
    setTaskTimelineEvents([]);
    setTaskInstructionInput("");
    setTaskIntervalInput(15);
    setTaskEnabledInput(true);
    setTaskError(null);
    setSchedulerStatus(null);
    setSchedulerError(null);
    setSchedulerLoading(false);
    setSchedulerCardPulse(false);
    setAvailableCommands([]);
    setCommandPickerOpen(false);
    setCommandSearch("");
    setRuntimeModels([]);
    setRuntimeAgents([]);
    setSelectedModel(null);
    setSelectedAgent(null);
    setRuntimeLoading(false);
    setRuntimeSaving(false);
    setRuntimeError(null);
    setProjectSessions([]);
    setSessionLoading(false);
    setSessionSwitching(false);
    setSessionError(null);
    setMobileProjectListOpen(false);
    setMobileSettingsOpen(false);
    setRecording(false);
    setTranscribingAudio(false);
    setSpeakingMessageId(null);
    setMessages([]);
    setDiffEntries([]);
    setRunIntentActive(false);
    setStopFeedbackLabel(null);
    setStopFeedbackUntilMs(null);
    setReconnectStartedAtMs(null);
    setReconnectAttemptCount(0);
    setPendingApprovals([]);
    setPendingQuestions([]);
    setQuestionDrafts({});
    setRespondingQuestionId(null);
  }

  async function handleSelectProject(projectId: string) {
    messageLoadRequestRef.current += 1;
    taskLoadRequestRef.current += 1;
    sessionLoadRequestRef.current += 1;
    projectFilePreviewRequestRef.current += 1;
    await selectProject(projectId);
    addTelemetryMarker("project.select", {
      projectId,
      mode: isSearchMode ? "search" : "base",
      searchQuery,
    });
    setActiveProjectId(projectId);
    setHighlightedProjectId(projectId);
    setPendingApprovals([]);
    setPendingQuestions([]);
    setQuestionDrafts({});
    setRespondingQuestionId(null);
    setStopFeedbackLabel(null);
    setStopFeedbackUntilMs(null);
    setActiveSessionId(null);
    resetTimelineExpansionState();
    setUnreadEntryId(null);
    setIsChatNearBottom(true);
    setMobileProjectListOpen(false);
    setMobileSettingsOpen(false);
    setMessages([]);
    setTaskTimelineEvents([]);
    setDiffEntries([]);
    await Promise.all([
      loadMessages(projectId, { sessionId: undefined }),
      loadPendingApprovals(projectId),
      loadPendingQuestions(projectId),
    ]);
    void loadDiff(projectId);
  }

  async function ensureBaseProjectLoaded(projectId: string) {
    if (projects.some((project) => project.id === projectId) || !projectsHasMore) {
      return;
    }

    let nextProjects = projects;
    let nextHasMore: boolean = projectsHasMore;
    let nextOffset = projects.length;

    while (!nextProjects.some((project) => project.id === projectId) && nextHasMore) {
      const page = await fetchProjects({ limit: PROJECTS_PAGE_SIZE, offset: nextOffset });
      const seen = new Set(nextProjects.map((project) => project.id));
      const additions = page.projects.filter((project) => !seen.has(project.id));
      nextProjects = [...nextProjects, ...additions];
      nextHasMore = page.hasMore;
      nextOffset = nextProjects.length;
    }

    setProjects(nextProjects);
    setProjectsHasMore(nextHasMore);
    setProjectsTotal((current) => Math.max(current, nextProjects.length));
  }

  function handleProjectSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    if (projectSearch.trim()) {
      addTelemetryMarker("search.clear.escape", { queryLength: projectSearch.trim().length });
    }
    setProjectSearch("");
    event.currentTarget.blur();
  }

  async function handleSwitchSession(nextSessionId: string) {
    if (!activeProjectId || !nextSessionId || nextSessionId === activeSessionId) {
      return;
    }

    const targetSession = projectSessions.find((session) => session.id === nextSessionId) ?? null;
    setSessionSwitching(true);
    setSessionSwitchTargetLabel(
      targetSession ? formatSessionOptionLabel(targetSession, nextSessionId) : formatCompactSessionId(nextSessionId)
    );
    setSessionError(null);
    setProjectError(null);
    setStopFeedbackLabel(null);
    setStopFeedbackUntilMs(null);
    resetTimelineExpansionState();
    setUnreadEntryId(null);
    setIsChatNearBottom(true);
    setMobileSettingsOpen(false);
    try {
      const result = await updateProjectSession(activeProjectId, nextSessionId);
      const switchedSessionId = result.activeSessionId;
      setActiveSessionId(switchedSessionId);
      updateProjectSessionSelection(activeProjectId, switchedSessionId);
      setPendingApprovals([]);
      setPendingQuestions([]);
      setQuestionDrafts({});
      await Promise.all([
        loadProjectSessions(activeProjectId, { silent: true }),
        loadMessages(activeProjectId, { sessionId: switchedSessionId }),
        loadPendingApprovals(activeProjectId),
        loadPendingQuestions(activeProjectId),
      ]);
      void loadDiff(activeProjectId);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Failed to switch session");
    } finally {
      setSessionSwitching(false);
      setSessionSwitchTargetLabel(null);
    }
  }

  async function handleCreateSession() {
    if (!activeProjectId) {
      return;
    }

    setSessionSwitching(true);
    setSessionError(null);
    setProjectError(null);
    setStopFeedbackLabel(null);
    setStopFeedbackUntilMs(null);
    resetTimelineExpansionState();
    setUnreadEntryId(null);
    setIsChatNearBottom(true);
    setMobileSettingsOpen(false);
    try {
      const result = await createProjectSession(activeProjectId);
      const createdSessionId = result.activeSessionId;
      setActiveSessionId(createdSessionId);
      updateProjectSessionSelection(activeProjectId, createdSessionId);
      setPendingApprovals([]);
      setPendingQuestions([]);
      setQuestionDrafts({});
      setMessages([]);
      setTaskTimelineEvents([]);
      setDiffEntries([]);
      await Promise.all([
        loadProjectSessions(activeProjectId, { silent: true }),
        loadMessages(activeProjectId, { sessionId: createdSessionId }),
        loadPendingApprovals(activeProjectId),
        loadPendingQuestions(activeProjectId),
      ]);
      void loadDiff(activeProjectId);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Failed to create session");
    } finally {
      setSessionSwitching(false);
    }
  }

  async function handleDeleteSession() {
    if (!activeProjectId || !activeSessionId) {
      return;
    }

    const targetSession = projectSessions.find((session) => session.id === activeSessionId) ?? null;
    const targetLabel = targetSession ? formatSessionOptionLabel(targetSession, activeSessionId) : formatCompactSessionId(activeSessionId);
    const confirmMessage = [
      "Delete this session?",
      "",
      targetLabel,
      "",
      "This removes the session from OpenCode for this project.",
      "If it is the last session, this project will also be removed from the chat list.",
    ].join("\n");
    if (!window.confirm(confirmMessage)) {
      return;
    }

    setSessionSwitching(true);
    setSessionError(null);
    setProjectError(null);
    setStopFeedbackLabel(null);
    setStopFeedbackUntilMs(null);
    resetTimelineExpansionState();
    setUnreadEntryId(null);
    setIsChatNearBottom(true);
    setMobileSettingsOpen(false);
    try {
      const result = await deleteProjectSession(activeProjectId, activeSessionId);
      const deletedResultSessionId = result.activeSessionId;
      setProjectSessions(result.sessions);
      setActiveSessionId(deletedResultSessionId);
      updateProjectSessionSelection(activeProjectId, deletedResultSessionId);
      setPendingApprovals([]);
      setPendingQuestions([]);
      setQuestionDrafts({});
      setMessages([]);
      setTaskTimelineEvents([]);
      setDiffEntries([]);
      if (result.projectDeleted) {
        setProjects((current) => current.filter((project) => project.id !== activeProjectId));
        setSearchProjects((current) => current.filter((project) => project.id !== activeProjectId));
        setActiveSessionId(null);
        setActiveProjectId(result.activeProjectId ?? null);
        const nextProjectId = await refreshProjectsAndStatus(result.activeProjectId ?? null);
        if (nextProjectId) {
          await Promise.all([
            loadMessages(nextProjectId, { sessionId: undefined }),
            loadPendingApprovals(nextProjectId),
            loadPendingQuestions(nextProjectId),
          ]);
          void loadDiff(nextProjectId);
        }
        return;
      }
      if (deletedResultSessionId) {
        await Promise.all([
          loadMessages(activeProjectId, { sessionId: deletedResultSessionId }),
          loadPendingApprovals(activeProjectId),
          loadPendingQuestions(activeProjectId),
        ]);
        void loadDiff(activeProjectId);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Failed to delete session");
    } finally {
      setSessionSwitching(false);
    }
  }

  async function handleCompactSession() {
    if (!activeProjectId || !activeSessionId || compacting) {
      return;
    }

    const modelToUse = selectedModel || (runtimeModels.find((m) => m.isDefault)?.id ?? null);
    if (!modelToUse) {
      setProjectError("No model selected. Select a model before compacting.");
      return;
    }
    const slashIndex = modelToUse.indexOf("/");
    if (slashIndex <= 0 || slashIndex === modelToUse.length - 1) {
      setProjectError("Invalid model format.");
      return;
    }
    const providerID = modelToUse.slice(0, slashIndex);
    const modelID = modelToUse.slice(slashIndex + 1);

    setCompacting(true);
    setProjectError(null);
    try {
      await compactSession(activeProjectId, activeSessionId, providerID, modelID);
      addTelemetryMarker("chat.compact", { projectId: activeProjectId });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to compact session");
    } finally {
      setCompacting(false);
    }
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProjectError(null);

    const trimmedProjectName = newProjectName.trim();
    if (!trimmedProjectName) {
      setProjectError("Project name is required");
      return;
    }

    const effectiveRootPath =
      normalizeProjectRootPath(newProjectRootPath) || normalizeProjectRootPath(newProjectPath);
    const targetProjectPath = buildProjectPathFromRoot(effectiveRootPath, trimmedProjectName);
    if (!targetProjectPath) {
      setProjectError("Project root path is required");
      return;
    }

    setCreatingProject(true);
    try {
      await createProject({
        name: trimmedProjectName,
        path: targetProjectPath,
      });
      setNewProjectName("");
      setNewProjectRootPath(preferredProjectRoot);
      setNewProjectPath(preferredProjectRoot);
      setMobileNewProjectOpen(false);
      await refreshProjectsAndStatus(activeProjectId);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Unable to create project");
    } finally {
      setCreatingProject(false);
    }
  }

  async function pickDirectoryNameWithFileInput(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
      input.style.position = "fixed";
      input.style.left = "-10000px";

      const cleanup = () => {
        input.removeEventListener("change", handleChange);
        input.remove();
      };

      const handleChange = () => {
        const files = input.files;
        if (!files || files.length === 0) {
          cleanup();
          resolve(null);
          return;
        }

        const firstFile = files[0] as File & { webkitRelativePath?: string };
        const relativePath = typeof firstFile.webkitRelativePath === "string" ? firstFile.webkitRelativePath : "";
        const directoryName = relativePath.split("/").filter(Boolean)[0] ?? null;
        cleanup();
        resolve(directoryName);
      };

      input.addEventListener("change", handleChange);
      document.body.appendChild(input);
      input.click();
    });
  }

  async function handlePickProjectDirectory() {
    const pickerWindow = window as Window & {
      showDirectoryPicker?: () => Promise<{ name?: string }>;
    };

    if (pickerWindow.showDirectoryPicker) {
      try {
        const handle = await pickerWindow.showDirectoryPicker();
        const fallbackName = typeof handle.name === "string" ? handle.name.trim() : "";
        if (preferredProjectRoot && fallbackName) {
          const nextRootPath = preferredProjectRoot;
          setNewProjectRootPath(nextRootPath);
          setNewProjectName(fallbackName);
          setNewProjectPath(buildProjectPathFromRoot(nextRootPath, fallbackName));
          setProjectError(null);
        } else {
          setProjectError("Folder selected. Paste the absolute path if the browser cannot expose it directly.");
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setProjectError(error instanceof Error ? error.message : "Unable to open folder picker");
      }
      return;
    }

    try {
      const fallbackName = await pickDirectoryNameWithFileInput();
      if (!fallbackName) {
        setProjectError("Folder picker is not supported in this browser. Enter the path manually.");
        return;
      }

      if (preferredProjectRoot) {
        const nextRootPath = preferredProjectRoot;
        setNewProjectRootPath(nextRootPath);
        setNewProjectName(fallbackName);
        setNewProjectPath(buildProjectPathFromRoot(nextRootPath, fallbackName));
        setProjectError(null);
      } else {
        setProjectError("Folder selected. Enter the absolute path manually for this browser.");
      }
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Unable to open folder picker");
    }
  }

  async function handleSelectProjectFile(path: string) {
    if (!activeProjectId) {
      return;
    }
    setSelectedProjectFilePath(path);
    await loadProjectFilePreview(activeProjectId, path);
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId || sending || hasBlockingApprovals || hasBlockingQuestions) {
      return;
    }

    const text = composerValue.trim();
    if (!text) {
      return;
    }

    setSending(true);
    setRunIntentActive(true);
    setAbortSuppressStreaming(false);
    setProjectError(null);
    if (notificationsEnabled && (notificationChannel === "browser" || notificationChannel === "both")) {
      void requestBrowserNotificationPermission();
    }

    const userEcho: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      createdAt: new Date().toISOString(),
      text,
      parts: [{ type: "text", text }],
    };
    setMessages((current) => [...current, userEcho]);
    setIsChatNearBottom(true);
    setUnreadEntryId(null);
    setComposerValue("");

    try {
      const parsed = parseSlashCommand(text);
      if (parsed) {
        // Command path — backend returns the result message synchronously
        const result = await runCommand(activeProjectId, parsed.command, parsed.argumentsList, activeSessionId);
        setMessages((current) => [
          ...current.filter((m) => !m.id.startsWith("local-")),
          result.message,
        ]);
      } else {
        // Regular message path — response arrives via SSE events
        const result = await sendMessage(activeProjectId, text, activeSessionId);
        awaitingFinalReplyNotificationByChatRef.current[`${activeProjectId}:${result.sessionId}`] = true;
        setMessages((current) => current.filter((m) => !m.id.startsWith("local-")));
      }

      await refreshProjectsAndStatus(activeProjectId);
      await Promise.all([
        loadProjectSessions(activeProjectId, { silent: true }),
        loadPendingApprovals(activeProjectId),
        loadPendingQuestions(activeProjectId),
      ]);
      void loadDiff(activeProjectId);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to send message");
      setMessages((current) => current.filter((message) => message.id !== userEcho.id));
      setComposerValue(text);
    } finally {
      setSending(false);
    }
  }

  async function handleAbortGeneration() {
    if (!activeProjectId || aborting) {
      return;
    }

    addTelemetryMarker("chat.stop.composer_click", {
      projectId: activeProjectId,
      streamStatus,
    });
    setRunIntentActive(true);
    setAborting(true);
    setProjectError(null);
    try {
      await abortSession(activeProjectId, activeSessionId);
      setStopFeedbackLabel("Stop requested. Waiting for final session update...");
      setStopFeedbackUntilMs(Date.now() + 4_000);
      addTelemetryMarker("chat.abort.manual", { projectId: activeProjectId });
      await Promise.all([
        loadMessages(activeProjectId, { sessionId: activeSessionId ?? undefined }),
        loadPendingApprovals(activeProjectId),
        loadPendingQuestions(activeProjectId),
      ]);
      void loadDiff(activeProjectId);
      await refreshProjectsAndStatus(activeProjectId);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to abort generation");
    } finally {
      setAborting(false);
      setRunIntentActive(false);
      setAbortSuppressStreaming(true);
    }
  }

  function handleChatScroll(event: UIEvent<HTMLElement>) {
    const body = event.currentTarget;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    setIsChatNearBottom(nearBottom);

    if (!nearBottom || !activeChatKey || timelineEntries.length === 0) {
      return;
    }

    const latestEntryId = timelineEntries[timelineEntries.length - 1]?.id;
    if (!latestEntryId) {
      return;
    }

    latestReadEntryIdByChatRef.current[activeChatKey] = latestEntryId;
    setUnreadEntryId(null);
  }

  function handleScrollToUnread() {
    const targetEntryId = unreadEntryId ?? timelineEntries[timelineEntries.length - 1]?.id ?? null;
    if (!targetEntryId) {
      return;
    }

    scrollEntryIntoView(chatBodyRef.current, timelineEntryRefs.current[targetEntryId] ?? null);
  }

  async function handleTranscribeBlob(audioBlob: Blob) {
    setTranscribingAudio(true);
    setProjectError(null);
    try {
      const result = await transcribeAudio({ audio: audioBlob });
      if (result.text?.trim()) {
        setComposerValue((current) => (current ? `${current} ${result.text.trim()}` : result.text.trim()));
      }
      addTelemetryMarker("chat.stt.transcribed", { chars: result.text?.length ?? 0 });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to transcribe audio");
    } finally {
      setTranscribingAudio(false);
    }
  }

  async function handleToggleRecording() {
    if (recording) {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      setRecording(false);
      return;
    }

    setProjectError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support microphone recording");
      }
      if (typeof MediaRecorder === "undefined") {
        throw new Error("This browser does not support MediaRecorder");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      mediaChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          mediaChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(mediaChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        cleanupMediaRecorder();
        if (blob.size > 0) {
          void handleTranscribeBlob(blob);
        }
      };

      recorder.start();
      setRecording(true);
      addTelemetryMarker("chat.stt.record_start");
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Microphone access failed");
      cleanupMediaRecorder();
    }
  }

  async function handleSpeakMessage(message: ChatMessage) {
    const text = message.text?.trim();
    if (!text) {
      return;
    }

    if (speakingMessageId === message.id) {
      stopSpeakingAudio();
      return;
    }

    stopSpeakingAudio();
    setProjectError(null);
    setSpeakingMessageId(message.id);

    try {
      const audioBlob = await speakText({ text, format: "mp3" });
      const url = URL.createObjectURL(audioBlob);
      speakingUrlRef.current = url;
      const audio = new Audio(url);
      speakingAudioRef.current = audio;
      audio.onended = () => {
        stopSpeakingAudio();
      };
      await audio.play();
      addTelemetryMarker("chat.tts.play", { messageId: message.id, chars: text.length });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Failed to play TTS audio");
      stopSpeakingAudio();
    }
  }

  function handleInsertCommand(commandName: string) {
    const nextValue = `/${commandName} `;
    setComposerValue(nextValue);
    setCommandPickerOpen(false);
    setCommandSearch("");
  }

  async function handleInstallApp() {
    if (!deferredInstallPrompt || appInstalled || installingApp) {
      return;
    }

    setInstallingApp(true);
    try {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome !== "accepted") {
        setInstallingApp(false);
      }
      setDeferredInstallPrompt(null);
    } catch {
      setInstallingApp(false);
    }
  }

  async function handlePermissionDecision(
    permissionId: string,
    responseValue: "approve" | "deny"
  ) {
    if (!activeProjectId || respondingPermissionId) {
      return;
    }

    setRespondingPermissionId(permissionId);
    setProjectError(null);
    try {
      await respondPermission(activeProjectId, permissionId, responseValue, false);
      setPendingApprovals((current) =>
        current.filter((item) => item.permissionId !== permissionId)
      );

      const decisionMessage: ChatMessage = {
        id: `permission-${permissionId}-${Date.now()}`,
        role: "system",
        createdAt: new Date().toISOString(),
        text: `Permission ${responseValue === "approve" ? "approved" : "denied"}: ${permissionId}`,
        parts: [],
      };
      setMessages((current) => [...current, decisionMessage]);
      scheduleStreamRefresh(activeProjectId);
    } catch (error) {
      setProjectError(
        error instanceof Error ? error.message : "Failed to submit permission decision"
      );
    } finally {
      setRespondingPermissionId(null);
    }
  }

  function handleExportTelemetrySnapshot() {
    const selectedMarkerCategories = TELEMETRY_CATEGORIES.filter(
      (category) => markerCategoryFilter[category]
    );
    const snapshot = {
      capturedAt: new Date().toISOString(),
      mode: isSearchMode ? "search" : "base",
      renderedProjects: sortedVisibleProjects.length,
      visibleTotal: visibleProjectsTotal,
      activeProjectId,
      highlightedProjectId,
      base: {
        loadedProjects: projects.length,
        total: projectsTotal,
        hasMore: projectsHasMore,
        pageLoads: basePageLoads,
        lastLoadMs: lastBaseLoadMs,
      },
      search: {
        query: searchQuery,
        loadedProjects: searchProjects.length,
        total: searchTotal,
        hasMore: searchHasMore,
        pageLoads: searchPageLoads,
        lastLoadMs: lastSearchLoadMs,
        lastQuery: lastSearchQuery,
      },
      stream: {
        status: streamStatus,
      },
      markerFilter: {
        timeWindow: markerTimeWindow,
        selectedCategories: selectedMarkerCategories,
        totalMarkers: telemetryMarkers.length,
        timeWindowMarkers: timeFilteredTelemetryMarkers.length,
        exportedMarkers: filteredTelemetryMarkers.length,
      },
      markers: filteredTelemetryMarkers,
    };

    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.href = url;
    anchor.download = `project-telemetry-${timestamp}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function handleResetTelemetryCounters() {
    setBasePageLoads(0);
    setSearchPageLoads(0);
    setLastBaseLoadMs(null);
    setLastSearchLoadMs(null);
    setLastSearchQuery("");
    setTelemetryMarkers([]);
    setMarkerCategoryFilter({
      search: true,
      project: true,
      chat: true,
      stream: true,
      system: true,
    });
    setMarkerTimeWindow("all");
    firstMessageMarkerProjectsRef.current = new Set();
  }

  function handleToggleMarkerCategory(category: TelemetryMarkerCategory) {
    setMarkerCategoryFilter((current) => ({
      ...current,
      [category]: !current[category],
    }));
  }

  function handleChangeMarkerTimeWindow(value: TelemetryTimeWindow) {
    setMarkerTimeWindow(value);
  }

  if (authLoading && !isAuthenticated) {
    return <div className="loading-screen">Loading...</div>;
  }

  if (!isAuthenticated) {
    return <LoginView loading={authLoading} error={authError} onSubmit={handleLogin} />;
  }

  return (
    <div
      className="shell"
      ref={shellRef}
      style={
        isMobileViewport
          ? undefined
          : { gridTemplateColumns: `${desktopSidebarWidth}px 8px minmax(0, 1fr)` }
      }
    >
      <CommandPickerModal
        open={commandPickerOpen}
        query={commandSearch}
        commands={filteredCommandList}
        onClose={() => {
          setCommandPickerOpen(false);
          setCommandSearch("");
        }}
        onQueryChange={setCommandSearch}
        onInsert={handleInsertCommand}
      />
      {showMobileProjectList ? (
        <section className={`mobile-projects-screen ${showMobileProjectList ? "open" : ""}`}>
          <div className="mobile-projects-topbar">
            <div className="mobile-projects-title">
              <span className="mobile-app-avatar" aria-hidden="true">
                OC
              </span>
              <div>
                <h1>OpenCode</h1>
                <p>{sortedVisibleProjects.length} chats</p>
              </div>
            </div>
            <div className="mobile-projects-actions">
                <button type="button" className="mobile-icon-button" onClick={() => setMobileNewProjectOpen((current) => !current)}>
                {mobileNewProjectOpen ? "Close" : "Create"}
                </button>
              <button type="button" className="mobile-icon-button" onClick={handleLogout}>
                Exit
              </button>
            </div>
          </div>

          <div className="mobile-search-wrap">
            <input
              ref={mobileProjectSearchInputRef}
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              onKeyDown={handleProjectSearchKeyDown}
              placeholder="Search chats"
            />
            {searchQuery ? (
              <button type="button" className="mobile-clear-search-button" onClick={() => setProjectSearch("")}>Clear</button>
            ) : null}
          </div>
          <div className="search-status-line">{mobileSearchStatusLabel}</div>
          {mobileNewProjectOpen ? (
            <form
              className="mobile-new-project-card"
              onSubmit={(event) => {
                handleCreateProject(event);
              }}
            >
              <div className="mobile-new-project-head">
                <strong>Create chat project</strong>
                <small>Folder name will match project name</small>
              </div>
              <input
                value={newProjectName}
                onChange={(event) => handleNewProjectNameInput(event.target.value)}
                placeholder="Project name"
              />
              <input
                value={newProjectPath}
                onChange={(event) => handleNewProjectPathInput(event.target.value)}
                placeholder={preferredProjectRoot || "Project root path"}
              />
              {preferredProjectRoot ? <small>Root path: {preferredProjectRoot}</small> : null}
              <div className="mobile-new-project-actions">
                <button type="button" className="mobile-icon-button" onClick={() => setMobileNewProjectOpen(false)}>
                  Cancel
                </button>
                <button disabled={creatingProject} type="submit" className="mobile-sync-button">
                  {creatingProject ? "Creating" : "Create chat"}
                </button>
              </div>
            </form>
          ) : null}

          {activeProject ? (
            <button
              type="button"
              className="mobile-active-chat-pill"
              onClick={() => {
                setMobileProjectListOpen(false);
                setMobileSettingsOpen(false);
              }}
            >
              <span className="mobile-active-chat-avatar">{projectInitials(activeProject.name)}</span>
              <span className="mobile-active-chat-copy">
                <strong>{activeProject.name}</strong>
                <small>Open current conversation</small>
              </span>
            </button>
          ) : null}

          <div className="mobile-project-list-wrap">
            <VirtualizedProjectList
              key={searchQuery.toLowerCase()}
              projects={sortedVisibleProjects}
              activeProjectId={activeProjectId}
              highlightedProjectId={null}
              onSelect={handleSelectProject}
              emptyLabel={searchQuery ? "No matching chats" : "No chats yet"}
              searchQuery={searchQuery}
              totalLabel={`${sortedVisibleProjects.length} shown`}
              hasMore={visibleProjectsHasMore}
              isLoadingMore={isLoadingVisibleProjects}
              rowHeight={72}
              onReachEnd={() => {
                if (isSearchMode) {
                  void loadSearchProjects(searchQuery, searchProjects.length, false);
                  return;
                }
                void loadMoreProjects();
              }}
                    />
                  </div>
        </section>
      ) : null}
      <aside className="sidebar">
        <div className="sidebar-top">
          <h2>
            Projects ({sortedVisibleProjects.length}
            {visibleProjectsTotal > sortedVisibleProjects.length ? `/${visibleProjectsTotal}` : ""})
          </h2>
          <div className="sidebar-actions">
            <button onClick={handleLogout} type="button">
              Logout
            </button>
          </div>
        </div>

        <form className={`new-project ${desktopProjectControlsCollapsed ? "collapsed" : ""}`} onSubmit={handleCreateProject}>
          <div className="new-project-head">
            <div>
              <strong>Projects</strong>
              <small>Search and create local chat folders</small>
            </div>
            <button
              type="button"
              className="new-project-collapse-button"
              onClick={() => setDesktopProjectControlsCollapsed((current) => !current)}
              aria-expanded={!desktopProjectControlsCollapsed}
            >
              {desktopProjectControlsCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          <input
            ref={desktopProjectSearchInputRef}
            value={projectSearch}
            onChange={(event) => setProjectSearch(event.target.value)}
            onKeyDown={handleProjectSearchKeyDown}
            onFocus={() => {
              addTelemetryMarker("search.focus", {
                mode: isSearchMode ? "search" : "base",
                queryLength: searchQuery.length,
              });
            }}
            placeholder="Search projects (Ctrl+K)"
          />
          <div className="search-inline-actions">
            {searchQuery ? (
              <button type="button" className="secondary-button search-clear-button" onClick={() => setProjectSearch("")}>
                Clear search
              </button>
            ) : null}
          </div>
          <small className="search-status-line">{searchSummaryLabel}</small>
          <div className={`new-project-extra ${desktopProjectControlsCollapsed ? "collapsed" : ""}`}>
            <input
              value={newProjectName}
              onChange={(event) => handleNewProjectNameInput(event.target.value)}
              placeholder="Project name"
            />
            <input
              value={newProjectPath}
              onChange={(event) => handleNewProjectPathInput(event.target.value)}
              placeholder={preferredProjectRoot || "Project root path"}
            />
            <div className="new-project-hint-row">
              <small>{preferredProjectRoot ? `Root path: ${preferredProjectRoot}` : "Enter an absolute root folder path"}</small>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  const nextRootPath = preferredProjectRoot;
                  setNewProjectRootPath(nextRootPath);
                  setNewProjectPath(buildProjectPathFromRoot(nextRootPath, newProjectName.trim()));
                }}
                disabled={!preferredProjectRoot}
              >
                Use suggested
              </button>
            </div>
            <div className="new-project-actions-row">
              <button type="button" className="ghost-button" onClick={() => void handlePickProjectDirectory()}>
                Choose folder
              </button>
              <button disabled={creatingProject} type="submit">
                {creatingProject ? "Creating..." : "Create chat"}
              </button>
            </div>
          </div>
        </form>

        <VirtualizedProjectList
          key={searchQuery.toLowerCase()}
          projects={sortedVisibleProjects}
          activeProjectId={activeProjectId}
          highlightedProjectId={highlightedProjectId}
          onSelect={handleSelectProject}
          emptyLabel={searchQuery ? "No matching projects" : "No projects yet"}
          searchQuery={searchQuery}
          totalLabel={`${sortedVisibleProjects.length} shown${visibleProjectsTotal > sortedVisibleProjects.length ? ` of ${visibleProjectsTotal}` : ""}`}
          hasMore={visibleProjectsHasMore}
          isLoadingMore={isLoadingVisibleProjects}
          rowHeight={84}
          onReachEnd={() => {
            if (isSearchMode) {
              void loadSearchProjects(searchQuery, searchProjects.length, false);
              return;
            }
            void loadMoreProjects();
          }}
        />

        <div className="sidebar-phone-link">
          <span>📱 Open on phone:</span>
          {lanUrl ? (
            <a
              href={lanUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {lanUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            <a
              href={window.location.origin}
              target="_blank"
              rel="noopener noreferrer"
            >
              {window.location.host}
            </a>
          )}
        </div>
      </aside>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize projects sidebar"
        aria-valuemin={300}
        aria-valuemax={680}
        aria-valuenow={Math.round(desktopSidebarWidth)}
        tabIndex={isMobileViewport ? -1 : 0}
        onPointerDown={(event) => {
          if (isMobileViewport) {
            return;
          }
          event.preventDefault();
          resizingSidebarRef.current = true;
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (isMobileViewport || !shellRef.current) {
            return;
          }

          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            return;
          }

          event.preventDefault();

          const rect = shellRef.current.getBoundingClientRect();
          const minSidebarWidth = 300;
          const minChatWidth = 420;
          const availableSidebarWidth = Math.max(0, rect.width - minChatWidth - 8);
          const effectiveMinSidebarWidth = Math.min(minSidebarWidth, availableSidebarWidth);
          const maxSidebarWidth = Math.max(effectiveMinSidebarWidth, Math.min(680, availableSidebarWidth));

          setDesktopSidebarWidth((current) => {
            if (event.key === "Home") {
              return effectiveMinSidebarWidth;
            }
            if (event.key === "End") {
              return maxSidebarWidth;
            }

            const delta = event.key === "ArrowRight" ? 24 : -24;
            return Math.min(maxSidebarWidth, Math.max(effectiveMinSidebarWidth, current + delta));
          });
        }}
      />

      <main className={`chat-pane ${showMobileProjectList ? "" : "visible"}`}>
        <header className="chat-header">
          {isMobileViewport ? (
            <button
              type="button"
              className="mobile-menu-button mobile-back-button"
              aria-label="Back to projects"
              onClick={() => setMobileProjectListOpen(true)}
            >
              ←
            </button>
          ) : null}
          {isMobileViewport && activeProject ? (
            <div className="mobile-chat-avatar" aria-hidden="true">
              {projectInitials(activeProject.name)}
            </div>
          ) : null}
          {!isMobileViewport && activeProject ? (
            <div className="chat-project-badge" aria-hidden="true">
              {projectInitials(activeProject.name)}
            </div>
          ) : null}
          <div className="chat-header-main">
            <h3>{activeProject?.name ?? "No project selected"}</h3>
            <p className="chat-project-path">
              {activeProject
                ? isMobileViewport
                  ? formatShortSessionLabel(activeSessionId)
                  : activeProject.path
                : "Pick a project from the left sidebar."}
            </p>
            {activeProject && !isMobileViewport ? (
              <p className="chat-header-meta">
                <span>Session {formatCompactSessionId(activeSessionId)}</span>
                {contextUsage ? (
                  <span className={`context-usage-badge context-usage-${contextUsage.color}`}>
                    Context: {(contextUsage.used / 1024).toFixed(1)}K / {(contextUsage.limit / 1024).toFixed(0)}K ({contextUsage.percentage}%)
                  </span>
                ) : null}
                {activeSession && activeSession.summary.files > 0 ? (
                  <span>
                    {activeSession.summary.files} files, +{activeSession.summary.additions}/-
                    {activeSession.summary.deletions}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="chat-header-controls">
            {activeProject && !isMobileViewport ? (
              <div className="main-view-toggle" role="tablist" aria-label="Main view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMainView === "chat"}
                  className={activeMainView === "chat" ? "active" : ""}
                  onClick={() => setActiveMainView("chat")}
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMainView === "files"}
                  className={activeMainView === "files" ? "active" : ""}
                  onClick={() => setActiveMainView("files")}
                >
                  Files
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMainView === "tasks"}
                  className={activeMainView === "tasks" ? "active" : ""}
                  onClick={() => setActiveMainView("tasks")}
                >
                  Tasks
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMainView === "git"}
                  className={activeMainView === "git" ? "active" : ""}
                  onClick={() => setActiveMainView("git")}
                >
                  Git
                </button>
              </div>
            ) : null}
            {!isMobileViewport ? (
              <span className="status">
                OpenCode: {opencodeStatus} | stream: {streamStatus}
                {hasActiveRun ? <span className="run-active-badge">Run active</span> : null}
                <button
                  type="button"
                  className={`scheduler-heartbeat ${schedulerHeartbeat.level}`}
                  onClick={focusSchedulerCard}
                  title="Show scheduler details (Shift+S)"
                >
                  {schedulerHeartbeat.label}
                </button>
              </span>
            ) : null}
            {isMobileViewport ? (
              <button
                type="button"
                className="mobile-menu-button"
                aria-label="Open settings"
                onClick={() => setMobileSettingsOpen(true)}
              >
                ⋮
              </button>
            ) : null}
          </div>
          {activeProject && isMobileViewport ? (
            <div className="main-view-toggle mobile-main-view-toggle" role="tablist" aria-label="Main view">
              <button
                type="button"
                role="tab"
                aria-selected={activeMainView === "chat"}
                className={activeMainView === "chat" ? "active" : ""}
                onClick={() => setActiveMainView("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeMainView === "files"}
                className={activeMainView === "files" ? "active" : ""}
                onClick={() => setActiveMainView("files")}
              >
                Files
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeMainView === "tasks"}
                className={activeMainView === "tasks" ? "active" : ""}
                onClick={() => setActiveMainView("tasks")}
              >
                Tasks
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeMainView === "git"}
                className={activeMainView === "git" ? "active" : ""}
                onClick={() => setActiveMainView("git")}
              >
                Git
              </button>
            </div>
          ) : null}
        </header>

        {activeProject && !isMobileViewport ? (
          <section className={`chat-toolbar ${desktopChatToolbarCollapsed ? "collapsed" : ""}`}>
            <div className="chat-toolbar-head">
              <div>
                <strong>Workspace controls</strong>
                <span>Runtime, install options, and notifications</span>
              </div>
              <button
                type="button"
                className="chat-toolbar-collapse-button"
                onClick={() => setDesktopChatToolbarCollapsed((current) => !current)}
                aria-expanded={!desktopChatToolbarCollapsed}
              >
                {desktopChatToolbarCollapsed ? "Expand" : "Collapse"}
              </button>
            </div>
            <div className={`chat-toolbar-content ${desktopChatToolbarCollapsed ? "collapsed" : ""}`}>
              <div className="chat-toolbar-grid">
                <div className="toolbar-card runtime-card">
                  <div className="toolbar-card-head">
                    <strong>Runtime</strong>
                    <span>Model and agent</span>
                  </div>
                    <RuntimeControls
                      models={runtimeModels}
                      agents={runtimeAgents}
                      sessions={projectSessions}
                      activeSessionId={activeSessionId}
                      selectedModel={selectedModel}
                      selectedAgent={selectedAgent}
                      globalDefaultModel={globalDefaultModel}
                      saving={runtimeSaving || runtimeLoading}
                      sessionLoading={sessionLoading}
                      sessionSwitching={sessionSwitching}
                      compacting={compacting}
                      error={runtimeError}
                      reloading={reloading}
                      reloadMessage={reloadMessage}
                      onReload={handleReloadRuntime}
                      onModelChange={(value) => {
                        void saveProjectRuntimeSelection({ model: value, agent: selectedAgent });
                      }}
                      onAgentChange={(value) => {
                        void saveProjectRuntimeSelection({ model: selectedModel, agent: value });
                      }}
                      onSessionChange={(value) => {
                        void handleSwitchSession(value);
                      }}
                      onSessionCreate={() => {
                        void handleCreateSession();
                      }}
                      onSessionDelete={() => {
                        void handleDeleteSession();
                      }}
                      onCompact={() => {
                        void handleCompactSession();
                      }}
                    />
                  </div>

                <div className="toolbar-card settings-card">
                  <div className="toolbar-card-head">
                    <strong>Settings</strong>
                    <span>Default model and notifications</span>
                  </div>
                  <label className="settings-default-model">
                    <span>Default model</span>
                    <select
                      value={globalDefaultModel ?? ""}
                      onChange={(event) => {
                        void handleSaveGlobalDefaultModel(event.currentTarget.value || null);
                      }}
                      disabled={globalDefaultModelSaving}
                    >
                      <option value="">Server default</option>
                      {runtimeModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.providerName} / {model.name}
                          {model.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <NotificationControls
                    supported={notificationPermission !== "unsupported"}
                    enabled={notificationsEnabled}
                    permission={notificationPermission}
                    channel={notificationChannel}
                    ntfyTopicUrl={ntfyTopicUrl}
                    saving={notificationSettingsSaving}
                    testing={notificationTesting}
                    onEnable={() => {
                      void handleEnableNotifications();
                    }}
                    onDisable={handleDisableNotifications}
                    onChannelChange={setNotificationChannel}
                    onNtfyTopicUrlChange={setNtfyTopicUrl}
                    onSaveSettings={() => {
                      void handleSaveNotificationSettings();
                    }}
                    onTestNtfy={() => {
                      void handleTestNtfy();
                    }}
                  />
                </div>

                <div className="toolbar-card install-card">
                  <InstallControls
                    canInstall={deferredInstallPrompt !== null}
                    installed={appInstalled}
                    installMessage={installMessage}
                    installing={installingApp}
                    onInstall={() => {
                      void handleInstallApp();
                    }}
                  />
                </div>

              </div>

            </div>
          </section>
        ) : null}

        {activeProject && isMobileViewport ? (
          <div className="mobile-chat-meta-strip visible">
            <button type="button" className={`scheduler-heartbeat ${schedulerHeartbeat.level}`} onClick={focusSchedulerCard}>
              {schedulerHeartbeat.label}
            </button>
            {hasActiveRun ? <span className="meta-pill run-active-pill">Run active</span> : null}
            <span className="meta-pill">{selectedAgent || "default agent"}</span>
            <span className="meta-pill">{selectedModel || "server model"}</span>
            {contextUsage ? (
              <span className={`meta-pill context-usage-pill context-usage-pill-${contextUsage.color}`}>
                {(contextUsage.used / 1024).toFixed(1)}K/{(contextUsage.limit / 1024).toFixed(0)}K ({contextUsage.percentage}%)
              </span>
            ) : null}
          </div>
        ) : null}

        {activeMainView === "chat" ? (
        <section className="chat-body" ref={chatBodyRef} onScroll={handleChatScroll}>
          {fixtureMode ? <FixtureBanner mode={fixtureMode} /> : null}
          {stopFeedbackVisible ? (
            <div className="stop-feedback-row" role="status" aria-live="polite">
              {stopFeedbackLabel}
            </div>
          ) : null}
          <div className={`chat-transition-shell ${transitionStatus ? "active" : ""}`}>
            {transitionStatus ? (
              <ChatTransitionStrip
                tone={transitionStatus.tone}
                label={transitionStatus.label}
                detail={transitionStatus.detail}
              />
            ) : null}
          </div>
          {compacting ? (
            <div className="compaction-status-strip">
              <span className="compaction-spinner" />
              <span>Compacting session — summarizing conversation history...</span>
            </div>
          ) : null}
          {fixtureMode === "no-project" ? (
            <ChatStateCard
              title="Select a project to start chatting."
              detail="Fixture preview for the no-project state. Remove `?fixture=no-project` to return to the live chat."
            />
          ) : !activeProject ? (
            <ChatStateCard
              title="Select a project to start chatting."
              detail="Choose a project from the sidebar to load its OpenCode session and message history."
            />
          ) : null}
          {activeProject && fixtureMode !== "no-project" && renderedTimelineEntries.length === 0 && !messagesLoading && fixtureMode !== "chat-loading" ? <EmptyState /> : null}
          {fixtureMode === "chat-loading" ? (
            <ChatStateCard
              title="Loading this session..."
              detail="Fixture preview for the loading state. Remove `?fixture=chat-loading` to return to the live chat."
            />
          ) : messagesLoading && !sessionSwitching ? (
            <ChatStateCard
              title="Loading this session..."
              detail="Fetching message history, activity, and pending approvals for the selected project."
            />
          ) : null}
          {activeProject && fixtureMode !== "no-project" && hasBlockingApprovals ? (
            <div className="approval-list">
              {visiblePendingApprovals.map((approval) => (
                <article className="approval-card" key={approval.permissionId}>
                  <header>
                    <strong>{approval.title}</strong>
                    <span>{approval.permissionId}</span>
                  </header>
                  <p>{approval.details}</p>
                  <div className="approval-actions">
                    <button
                      type="button"
                      disabled={respondingPermissionId === approval.permissionId}
                      onClick={() => handlePermissionDecision(approval.permissionId, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={respondingPermissionId === approval.permissionId}
                      onClick={() => handlePermissionDecision(approval.permissionId, "deny")}
                    >
                      Deny
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          {activeProject && renderedTimelineEntries.length > 0 ? (
            <div className="messages-list">
              {renderedTimelineEntries.map((entry, index) => {
                const previousEntry = index > 0 ? renderedTimelineEntries[index - 1] : null;
                const nextEntry = index < renderedTimelineEntries.length - 1 ? renderedTimelineEntries[index + 1] : null;
                const entryDay = new Date(entry.createdAt).toDateString();
                const previousDay = previousEntry ? new Date(previousEntry.createdAt).toDateString() : null;
                const showDaySeparator = entryDay !== previousDay;
                const previousMessage = previousEntry?.kind === "message" ? previousEntry.message : null;
                const nextMessage = nextEntry?.kind === "message" ? nextEntry.message : null;
                const attachedTop =
                  entry.kind === "message" &&
                  previousMessage !== null &&
                  previousMessage.role === entry.message.role &&
                  !showDaySeparator;
                const attachedBottom =
                  entry.kind === "message" &&
                  nextMessage !== null &&
                  nextEntry !== null &&
                  nextMessage.role === entry.message.role &&
                  new Date(nextEntry.createdAt).toDateString() === entryDay;

                return (
                  <div
                    key={entry.id}
                    ref={(node) => {
                      timelineEntryRefs.current[entry.id] = node;
                      if (entry.kind === "activity") {
                        for (const childId of entry.childIds) {
                          timelineEntryRefs.current[childId] = node;
                        }
                      }
                    }}
                    data-entry-id={entry.id}
                  >
                    {showDaySeparator ? (
                      <div className="message-day-separator">
                        <span>{formatTimelineDayLabel(entry.createdAt)}</span>
                      </div>
                    ) : null}
                    {entry.kind === "message" ? (
                      <div className={entry.message.mode === "compaction" ? "compaction-message" : ""}>
                        <MessageBubble
                        message={entry.message}
                        canSpeak={Boolean(entry.message.text?.trim())}
                        speaking={speakingMessageId === entry.message.id}
                        attachedTop={attachedTop}
                        attachedBottom={attachedBottom}
                        showParts={entry.message.role !== "assistant" || !entry.message.text.trim()}
                        collapseParts={entry.message.role === "assistant" && Boolean(entry.message.text.trim())}
                        onSpeak={handleSpeakMessage}
                        activityOpen={expandedMessageEntries[buildMessageStableKey(entry.message)] ?? false}
                        onActivityToggle={(nextOpen) => {
                          const messageKey = buildMessageStableKey(entry.message);
                          setExpandedMessageEntries((current) => ({
                            ...current,
                            [messageKey]: nextOpen,
                          }));
                        }}
                        expandedParts={expandedPartEntries}
                        onPartToggle={(partKey, nextOpen) => {
                          setExpandedPartEntries((current) => ({
                            ...current,
                            [partKey]: nextOpen,
                          }));
                        }}
                      />
                      </div>
                      ) : entry.kind === "activity" ? (
                        <AgentActivityCard
                          partItems={entry.partItems}
                          stateKey={entry.stateKey}
                          latestLabel={entry.latestLabel}
                          latestDetail={entry.latestDetail}
                          actionSummaries={entry.actionSummaries}
                          createdAt={entry.createdAt}
                          open={expandedActivityEntries[entry.stateKey] ?? false}
                          onToggle={(nextOpen) => {
                            setExpandedActivityEntries((current) => ({
                              ...current,
                              [entry.stateKey]: nextOpen,
                            }));
                          }}
                          expandedParts={expandedPartEntries}
                          onPartToggle={(partKey, nextOpen) => {
                            setExpandedPartEntries((current) => ({
                              ...current,
                              [partKey]: nextOpen,
                            }));
                          }}
                        />
                      ) : (
                      <TaskRunTimelineRow run={entry.run} />
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          {showDiffEmptyFixture ? (
            <div className="timeline-note-card">
              <strong>No file changes detected</strong>
              <small>Fixture preview for an empty diff response in this session.</small>
            </div>
          ) : null}
          {showDiffLargeFixture ? (
            <div className="timeline-note-card">
              <strong>Large diff summary: {effectiveDiffEntries.length} files changed</strong>
              <small>Fixture preview for heavy-change sessions before expanding the detailed diff panel.</small>
            </div>
          ) : null}
          <DiffPanel sessionDiff={effectiveDiffEntries} gitDiff={gitDiffEntries} />
          {unreadEntryId ? (
            <button
              type="button"
              className="scroll-to-unread"
              onClick={handleScrollToUnread}
              title="Jump to newest unread message"
              aria-label="Jump to newest unread message"
            >
              ↓
            </button>
          ) : null}
          {activeProject && fixtureMode !== "no-project" && hasBlockingQuestions ? (
            <div className="approval-list">
              {pendingQuestions.map((question) => (
                <QuestionCard
                  key={question.id}
                  question={question}
                  draft={questionDrafts[question.id] ?? buildInitialQuestionDraft(question)}
                  responding={respondingQuestionId === question.id}
                  onToggleOption={(questionIndex, optionLabel, multiple) => {
                    handleQuestionOptionToggle(question.id, questionIndex, optionLabel, multiple);
                  }}
                  onCustomValueChange={(questionIndex, value) => {
                    handleQuestionCustomValueChange(question.id, questionIndex, value);
                  }}
                  onSubmit={() => {
                    void handleReplyQuestion(question);
                  }}
                  onReject={() => {
                    void handleRejectQuestion(question);
                  }}
                />
              ))}
            </div>
          ) : null}
        </section>
        ) : activeMainView === "tasks" ? (
          <section className="tasks-main-view">
            {activeProject ? (
              <ScheduledTaskPanel
                loading={taskLoading}
                saving={taskSaving}
                running={taskRunning}
                deleting={taskDeleting}
                error={taskError}
                name={taskNameInput}
                description={taskDescriptionInput}
                instruction={taskInstructionInput}
                taskType={taskTypeInput}
                intervalMinutes={taskIntervalInput}
                cronExpression={taskCronInput}
                onceRunAt={taskOnceInput}
                startsAtDate={taskStartsDateInput}
                startsAtTime={taskStartsTimeInput}
                endsAtDate={taskEndsDateInput}
                endsAtTime={taskEndsTimeInput}
                timezone={taskTimezoneInput}
                model={taskModelInput}
                agent={taskAgentInput}
                maxRuns={taskMaxRunsInput}
                runTimeoutMinutes={taskTimeoutInput}
                retryCount={taskRetryCountInput}
                retryBackoffMinutes={taskRetryBackoffInput}
                heartbeatEnabled={taskHeartbeatInput}
                goalDefinition={taskGoalInput}
                autoDisableOnGoalMet={taskAutoDisableOnGoalMetInput}
                notificationUrl={taskNotificationUrlInput}
                enabled={taskEnabledInput}
                task={scheduledTask}
                tasks={scheduledTasks}
                runs={scheduledRuns}
                previewRuns={taskPreviewRuns}
                runtimeModels={runtimeModels}
                runtimeAgents={runtimeAgents}
                globalDefaultModel={globalDefaultModel}
                ralphPanel={
                  <RalphLoopPanel
                    prdData={prdData}
                    prdLoading={prdLoading}
                    prdError={prdError}
                    prdInitializing={prdInitializing}
                    onInitPrd={handleInitPrd}
                    onCreateRalphTask={handleCreateRalphTask}
                  />
                }
                onNewTask={resetTaskForm}
                onSelectTask={(task) => {
                  void handleSelectTask(task);
                }}
                onNameChange={setTaskNameInput}
                onDescriptionChange={setTaskDescriptionInput}
                onTaskTypeChange={setTaskTypeInput}
                onInstructionChange={setTaskInstructionInput}
                onIntervalChange={setTaskIntervalInput}
                onCronExpressionChange={setTaskCronInput}
                onOnceRunAtChange={setTaskOnceInput}
                onStartsAtDateChange={setTaskStartsDateInput}
                onStartsAtTimeChange={setTaskStartsTimeInput}
                onEndsAtDateChange={setTaskEndsDateInput}
                onEndsAtTimeChange={setTaskEndsTimeInput}
                onTimezoneChange={setTaskTimezoneInput}
                onModelChange={setTaskModelInput}
                onAgentChange={setTaskAgentInput}
                onMaxRunsChange={setTaskMaxRunsInput}
                onRunTimeoutMinutesChange={setTaskTimeoutInput}
                onRetryCountChange={setTaskRetryCountInput}
                onRetryBackoffMinutesChange={setTaskRetryBackoffInput}
                onHeartbeatEnabledChange={setTaskHeartbeatInput}
                onGoalDefinitionChange={setTaskGoalInput}
                onAutoDisableOnGoalMetChange={setTaskAutoDisableOnGoalMetInput}
                onNotificationUrlChange={setTaskNotificationUrlInput}
                onEnabledChange={setTaskEnabledInput}
                onSave={handleSaveTask}
                onRunNow={handleRunTaskNow}
                onDelete={handleDeleteTask}
                onPauseResume={handlePauseResumeTask}
                onPreview={handlePreviewTaskSchedule}
              />
            ) : (
              <ChatStateCard
                title="No project selected"
                detail="Pick a project to manage its scheduled tasks."
              />
            )}
          </section>
        ) : activeMainView === "git" ? (
          <section className="git-main-view">
            {activeProject ? (
              <GitView projectId={activeProject.id} mobile={isMobileViewport} />
            ) : (
              <ChatStateCard
                title="No project selected"
                detail="Pick a project to manage branches, changes, and commit history."
              />
            )}
          </section>
        ) : (
          <section className="files-workspace">
            {activeProject ? (
              <ProjectFilesPanel
                projectId={activeProject.id}
                entries={projectFileEntries}
                truncated={projectFilesTruncated}
                loading={projectFilesLoading}
                loadedDirectories={projectFileLoadedDirs}
                loadingDirectories={projectFileLoadingDirs}
                loadError={projectFilesError}
                query={projectFileQuery}
                onQueryChange={setProjectFileQuery}
                selectedFilePath={selectedProjectFilePath}
                onSelectFile={(path) => {
                  void handleSelectProjectFile(path);
                }}
                onExpandDirectory={async (path) => {
                  await loadProjectDirectoryEntries(activeProject.id, path, false);
                }}
                content={selectedProjectFileContent}
                contentLoading={projectFileContentLoading}
                contentError={projectFileContentError}
                mobile={isMobileViewport}
              />
            ) : (
              <ChatStateCard
                title="No project selected"
                detail="Pick a project to browse files."
              />
            )}
          </section>
        )}

        {activeProject && isMobileViewport ? (
          <section className={`mobile-settings-screen ${mobileSettingsOpen ? "open" : ""}`}>
            <div className="mobile-settings-screen-head">
              <button type="button" className="mobile-back-button" onClick={() => setMobileSettingsOpen(false)}>
                ←
              </button>
              <div className="mobile-settings-screen-title">
                <strong>Chat Settings</strong>
                <small>{activeProject.name}</small>
                {sessionSwitching || showSessionSwitchFixture ? (
                  <small>
                    Switching to {showSessionSwitchFixture ? "voice_typing · Current · 01:44 PM" : sessionSwitchTargetLabel || "selected session"}...
                  </small>
                ) : null}
              </div>
            </div>
            <div className="mobile-settings-screen-body">
              <div className="toolbar-card runtime-card">
                 <div className="toolbar-card-head">
                   <strong>Runtime</strong>
                   <span>Model, agent, and session</span>
                 </div>
                   <RuntimeControls
                     models={runtimeModels}
                     agents={runtimeAgents}
                     sessions={projectSessions}
                     activeSessionId={activeSessionId}
                     selectedModel={selectedModel}
                     selectedAgent={selectedAgent}
                     globalDefaultModel={globalDefaultModel}
                     saving={runtimeSaving || runtimeLoading}
                     sessionLoading={sessionLoading}
                     sessionSwitching={sessionSwitching}
                     compacting={compacting}
                      error={runtimeError}
                      reloading={reloading}
                      reloadMessage={reloadMessage}
                      onReload={handleReloadRuntime}
                      onModelChange={(value) => {
                        void saveProjectRuntimeSelection({ model: value, agent: selectedAgent });
                      }}
                      onAgentChange={(value) => {
                        void saveProjectRuntimeSelection({ model: selectedModel, agent: value });
                      }}
                      onSessionChange={(value) => {
                        void handleSwitchSession(value);
                      }}
                      onSessionCreate={() => {
                        void handleCreateSession();
                      }}
                      onSessionDelete={() => {
                        void handleDeleteSession();
                      }}
                      onCompact={() => {
                        void handleCompactSession();
                      }}
                    />
                 </div>
               <div className="toolbar-card settings-card">
                 <div className="toolbar-card-head">
                   <strong>Settings</strong>
                   <span>Default model and notifications</span>
                 </div>
                 <label className="settings-default-model">
                   <span>Default model</span>
                   <select
                     value={globalDefaultModel ?? ""}
                     onChange={(event) => {
                       void handleSaveGlobalDefaultModel(event.currentTarget.value || null);
                     }}
                     disabled={globalDefaultModelSaving}
                   >
                     <option value="">Server default</option>
                     {runtimeModels.map((model) => (
                       <option key={model.id} value={model.id}>
                         {model.providerName} / {model.name}
                         {model.isDefault ? " (default)" : ""}
                       </option>
                     ))}
                   </select>
                 </label>
                 <NotificationControls
                   supported={notificationPermission !== "unsupported"}
                   enabled={notificationsEnabled}
                   permission={notificationPermission}
                   channel={notificationChannel}
                   ntfyTopicUrl={ntfyTopicUrl}
                   saving={notificationSettingsSaving}
                   testing={notificationTesting}
                   onEnable={() => {
                     void handleEnableNotifications();
                   }}
                   onDisable={handleDisableNotifications}
                   onChannelChange={setNotificationChannel}
                   onNtfyTopicUrlChange={setNtfyTopicUrl}
                   onSaveSettings={() => {
                     void handleSaveNotificationSettings();
                   }}
                   onTestNtfy={() => {
                     void handleTestNtfy();
                   }}
                 />
               </div>
              <div className="toolbar-card install-card">
                <InstallControls
                  canInstall={deferredInstallPrompt !== null}
                  installed={appInstalled}
                  installMessage={installMessage}
                  installing={installingApp}
                  onInstall={() => {
                    void handleInstallApp();
                  }}
                />
              </div>
            </div>
          </section>
        ) : null}

        {activeMainView === "chat" ? (
        <form className="composer" onSubmit={handleSendMessage}>
          <button
            type="button"
            className="command-launch-button"
            onClick={() => setCommandPickerOpen(true)}
            disabled={availableCommands.length === 0 || hasActiveRun}
            title="Browse available server commands"
            aria-label="Browse available server commands"
          >
            /
          </button>
          <textarea
            ref={composerTextareaRef}
            rows={1}
            disabled={
              !activeProject ||
              sending ||
              transcribingAudio ||
              hasBlockingApprovals ||
              hasBlockingQuestions
            }
            value={composerValue}
            onChange={(event) => setComposerValue(event.target.value)}
            placeholder={
              !activeProject
                ? "Select a project to start"
                : hasBlockingApprovals
                ? "Respond to pending approval before sending new prompts"
                : hasBlockingQuestions
                ? "Respond to pending question before sending new prompts"
                : transcribingAudio
                ? "Transcribing audio..."
                : "Message"
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-actions">
            <button
              type="button"
              className={`mic-button ${recording ? "recording" : ""}`}
              onClick={() => void handleToggleRecording()}
              disabled={!activeProject || hasActiveRun || transcribingAudio || hasBlockingApprovals || hasBlockingQuestions}
              title={recording ? "Stop recording" : "Start voice input"}
            >
              {transcribingAudio ? "..." : recording ? "Stop" : "Mic"}
            </button>
            {hasActiveRun ? (
              <button
                type="button"
                className="composer-stop-button"
                onClick={() => void handleAbortGeneration()}
                disabled={!activeProject || aborting}
              >
                {aborting ? "Stopping..." : "Stop"}
              </button>
            ) : (
              <button
                disabled={!activeProject || sending || transcribingAudio || hasBlockingApprovals || hasBlockingQuestions}
                type="submit"
              >
                {sending ? "..." : "Send"}
              </button>
            )}
          </div>
        </form>
        ) : null}

        {projectError ? <div className="toast error">{projectError}</div> : null}
      </main>
    </div>
  );
}
