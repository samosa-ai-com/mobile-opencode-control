import type { QuestionRequest } from "../types";
import type { DevFixtureMode, TelemetryMarkerCategory, TelemetryTimeWindow, QuestionAnswerDraft, SchedulerStatus } from "../types/internal";

export function resolveDevFixtureMode(): DevFixtureMode | null {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return null;
  }

  const value = new URLSearchParams(window.location.search).get("fixture");
  switch (value) {
    case "task-run-success":
    case "task-run-error":
    case "chat-loading":
    case "no-project":
    case "run-active":
    case "reconnecting":
    case "session-switching":
    case "approval-heavy":
    case "activity-chain":
    case "diff-empty":
    case "diff-large":
      return value;
    default:
      return null;
  }
}

export function getManualInstallMessage() {
  if (typeof window === "undefined") {
    return "Install is available from your browser menu when supported.";
  }

  const userAgent = window.navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/i.test(userAgent);
  const isFirefox = /Firefox/i.test(userAgent);

  if (isIOS) {
    return "Use Share > Add to Home Screen to install this app.";
  }

  if (isFirefox) {
    return "Use your browser menu and choose Add to Home Screen to install this app.";
  }

  return "Install this app from your browser menu when the direct install prompt is not available.";
}

export function nextReconnectDelayMs(attempt: number): number {
  const baseDelay = 300;
  const capDelay = 5000;
  const exp = Math.min(capDelay, baseDelay * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 150);
  return exp + jitter;
}

export function scrollEntryIntoView(
  container: HTMLElement | null,
  entry: HTMLElement | null,
  behavior: ScrollBehavior = "smooth"
) {
  if (!container || !entry) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const entryRect = entry.getBoundingClientRect();
  const nextTop = container.scrollTop + (entryRect.top - containerRect.top) - 24;
  container.scrollTo({ top: Math.max(0, nextTop), behavior });
}

export function parseSlashCommand(input: string): { command: string; argumentsList: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const segments = trimmed
    .slice(1)
    .split(" ")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  return {
    command: segments[0],
    argumentsList: segments.slice(1),
  };
}

export function inferTelemetryCategory(event: string): TelemetryMarkerCategory {
  if (event.startsWith("search.")) {
    return "search";
  }
  if (event.startsWith("project.")) {
    return "project";
  }
  if (event.startsWith("chat.")) {
    return "chat";
  }
  if (event.startsWith("stream.")) {
    return "stream";
  }
  return "system";
}

export function markerTimeWindowMs(windowValue: TelemetryTimeWindow): number | null {
  if (windowValue === "1m") {
    return 60_000;
  }
  if (windowValue === "5m") {
    return 5 * 60_000;
  }
  if (windowValue === "15m") {
    return 15 * 60_000;
  }
  return null;
}

export function schedulerHeartbeatState(input: {
  schedulerStatus: SchedulerStatus | null;
  schedulerError: string | null;
  schedulerLoading: boolean;
}): { level: "ok" | "warn" | "error" | "idle"; label: string } {
  if (input.schedulerLoading && !input.schedulerStatus) {
    return { level: "idle", label: "scheduler checking" };
  }
  if (input.schedulerError) {
    return { level: "error", label: "scheduler error" };
  }
  if (!input.schedulerStatus) {
    return { level: "idle", label: "scheduler unknown" };
  }
  if (!input.schedulerStatus.running) {
    return { level: "error", label: "scheduler stopped" };
  }

  const loopAt = input.schedulerStatus.lastLoopAt
    ? new Date(input.schedulerStatus.lastLoopAt).getTime()
    : 0;
  if (!Number.isFinite(loopAt) || loopAt <= 0) {
    return { level: "warn", label: "scheduler warming" };
  }

  const ageMs = Date.now() - loopAt;
  const warnThresholdMs = Math.max(input.schedulerStatus.pollIntervalSeconds * 3000, 120_000);
  const errorThresholdMs = Math.max(input.schedulerStatus.pollIntervalSeconds * 10000, 600_000);

  if (ageMs > errorThresholdMs) {
    return { level: "error", label: "scheduler stale" };
  }
  if (ageMs > warnThresholdMs) {
    return { level: "warn", label: "scheduler delayed" };
  }
  return { level: "ok", label: "scheduler healthy" };
}

export function removeQuestionFromList(questions: QuestionRequest[], requestId: string) {
  return questions.filter((question) => question.id !== requestId);
}

export function buildInitialQuestionDraft(question: QuestionRequest): QuestionAnswerDraft {
  const optionSelections: Record<number, string[]> = {};
  const customValues: Record<number, string> = {};
  question.questions.forEach((_, index) => {
    optionSelections[index] = [];
    customValues[index] = "";
  });
  return { optionSelections, customValues };
}

export function buildQuestionReplyAnswers(question: QuestionRequest, draft: QuestionAnswerDraft): string[][] {
  return question.questions.map((info, index) => {
    const selected = draft.optionSelections[index] ?? [];
    const customValue = (draft.customValues[index] ?? "").trim();
    if (info.multiple) {
      return customValue ? [...selected, customValue] : selected;
    }
    if (customValue) {
      return [customValue];
    }
    return selected.slice(0, 1);
  });
}
