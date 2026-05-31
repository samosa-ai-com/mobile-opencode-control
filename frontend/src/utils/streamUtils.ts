import type { QuestionRequest } from "../types";
import type { ApprovalRequest } from "../types/internal";

export function extractJsonFromEventLines(eventLines: string[]): Record<string, unknown> | null {
  const payloadLines = eventLines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  if (payloadLines.length === 0) {
    return null;
  }

  const payload = payloadLines.join("\n");
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}


function classifyByTypeString(result: StreamEventClassification, eventType: string): void {
  result.rawEventType = eventType;
  if (eventType === "heartbeat") {
    result.isHeartbeat = true;
  } else if (eventType.includes("permission")) {
    result.hasApprovalUpdate = true;
  } else if (eventType === "question.asked" || eventType === "question.replied" || eventType === "question.rejected") {
    result.hasQuestionUpdate = true;
  } else if (eventType === "message.part.delta") {
    result.hasPartDelta = true;
  } else if (eventType === "message.part.updated") {
    result.hasPartUpdate = true;
  } else if (eventType === "message.part.removed") {
    result.hasPartRemove = true;
  } else if (eventType === "message.updated") {
    result.hasMessageUpdate = true;
  } else if (eventType === "message.removed") {
    result.hasMessageDelete = true;
  } else if (eventType === "todo.updated") {
    result.hasTodoUpdate = true;
  } else if (eventType === "session.diff") {
    result.hasDiffUpdate = true;
  } else if (eventType === "session.status" || eventType === "session.idle" || eventType === "session.compacted") {
    result.hasSessionUpdate = true;
  } else if (eventType.startsWith("session.next.compaction.")) {
    result.hasCompactionUpdate = true;
  }
}

export function classifyRawEvent(eventLines: string[]): StreamEventClassification {
  const result: StreamEventClassification = {
    hasMessageUpdate: false, hasQuestionUpdate: false, hasApprovalUpdate: false,
    hasPartDelta: false, hasPartUpdate: false, hasPartRemove: false,
    hasCompactionUpdate: false, hasSessionUpdate: false, hasTodoUpdate: false,
    hasDiffUpdate: false, hasMessageDelete: false, isHeartbeat: false,
    rawEventType: null,
  };

  for (const line of eventLines) {
    if (!line.startsWith("event: ")) continue;
    classifyByTypeString(result, line.slice(7).trim());
  }

  if (!result.rawEventType) {
    const payload = extractDataJsonFromRawEvent(eventLines);
    if (payload && typeof payload.type === "string") {
      classifyByTypeString(result, payload.type.toLowerCase());
    }
  }

  return result;
}


export function extractDataJsonFromRawEvent(eventLines: string[]): Record<string, unknown> | null {
  const dataLines = eventLines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  if (dataLines.length === 0) return null;

  try {
    return JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }
}


export function parseApprovalFromEventLines(eventLines: string[]) {
  try {
    const payload = extractDataJsonFromRawEvent(eventLines);
    if (!payload) return { request: null, resolvedPermissionId: null };

    const inner = (payload.payload as Record<string, unknown>) || payload;
    const typeValue = String(inner.type || "").toLowerCase();
    if (!typeValue.includes("permission")) {
      return { request: null, resolvedPermissionId: null };
    }
    const properties =
      inner.properties && typeof inner.properties === "object"
        ? (inner.properties as Record<string, unknown>)
        : inner;
    const permissionId = findPermissionId(properties);
    if (!permissionId) return { request: null, resolvedPermissionId: null };
    const resolved = isPermissionResolved(properties);
    if (resolved) {
      return { request: null, resolvedPermissionId: permissionId };
    }
    return {
      request: {
        permissionId,
        title: "Permission requested",
        details: JSON.stringify(properties),
        createdAt: new Date().toISOString(),
      },
      resolvedPermissionId: null,
    };
  } catch {
    return { request: null, resolvedPermissionId: null };
  }
}


export function parseQuestionFromEventLines(eventLines: string[]) {
  try {
    const payload = extractDataJsonFromRawEvent(eventLines);
    if (!payload) return { request: null, resolvedQuestionId: null };

    const inner = (payload.payload as Record<string, unknown>) || payload;
    const typeValue = String(inner.type || "").toLowerCase();
    const properties =
      inner.properties && typeof inner.properties === "object"
        ? (inner.properties as Record<string, unknown>)
        : inner;

    if (typeValue === "question.asked") {
      const id = typeof properties.id === "string" ? properties.id : null;
      const sessionID =
        typeof properties.sessionID === "string"
          ? properties.sessionID
          : typeof properties.sessionId === "string"
            ? properties.sessionId
            : null;
      const questions = Array.isArray(properties.questions) ? properties.questions : null;
      if (!id || !sessionID || !questions || questions.length === 0) {
        return { request: null, resolvedQuestionId: null };
      }
      return {
        request: {
          id,
          sessionID,
          questions: questions as QuestionRequest["questions"],
          tool: properties.tool && typeof properties.tool === "object" ? (properties.tool as QuestionRequest["tool"]) : undefined,
        },
        resolvedQuestionId: null,
      };
    }

    if (typeValue === "question.replied" || typeValue === "question.rejected") {
      const requestId =
        typeof properties.requestID === "string"
          ? properties.requestID
          : typeof properties.requestId === "string"
            ? properties.requestId
            : typeof properties.id === "string"
              ? properties.id
              : null;
      return { request: null, resolvedQuestionId: requestId };
    }
  } catch {
    // ignore malformed events
  }

  return { request: null, resolvedQuestionId: null };
}


export function eventMatchesSession(eventLines: string[], sessionID: string): boolean {
  const payload = extractDataJsonFromRawEvent(eventLines);
  if (!payload) return true;

  const inner = payload.payload as Record<string, unknown> | undefined;
  const target = inner && typeof inner.type === "string" ? inner : payload;
  const properties = target.properties as Record<string, unknown> | undefined;
  if (!properties) return true;

  const sid =
    (typeof properties.sessionID === "string" && properties.sessionID) ||
    (typeof properties.sessionId === "string" && properties.sessionId) ||
    null;

  return sid === null || sid === sessionID;
}

export function findPermissionId(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPermissionId(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidates = [
      record.permissionID,
      record.permissionId,
      record.permission_id,
      record.id,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }

    for (const item of Object.values(record)) {
      const found = findPermissionId(item);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

export function isPermissionResolved(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.toLowerCase();
    return (
      text.includes("allow") ||
      text.includes("deny") ||
      text.includes("reject") ||
      text.includes("approve")
    );
  }

  if (Array.isArray(value)) {
    return value.some((item) => isPermissionResolved(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const response = record.response ?? record.decision ?? record.action;
    if (typeof response === "string") {
      return true;
    }
    return Object.values(record).some((item) => isPermissionResolved(item));
  }

  return false;
}

export function parseApprovalFromStreamData(data: string): {
  request: ApprovalRequest | null;
  resolvedPermissionId: string | null;
} {
  try {
    const wrapper = JSON.parse(data) as { event?: string[] };
    const lines = Array.isArray(wrapper.event) ? wrapper.event : [];
    const payload = extractJsonFromEventLines(lines);
    if (!payload) {
      return { request: null, resolvedPermissionId: null };
    }

    // Unwrap GlobalEvent envelope
    const inner = (payload.payload as Record<string, unknown>) || payload;

    const typeValue = String(inner.type || "").toLowerCase();
    if (!typeValue.includes("permission")) {
      return { request: null, resolvedPermissionId: null };
    }

    const properties =
      inner.properties && typeof inner.properties === "object"
        ? (inner.properties as Record<string, unknown>)
        : inner;

    const permissionId = findPermissionId(properties);
    if (!permissionId) {
      return { request: null, resolvedPermissionId: null };
    }

    const details = JSON.stringify(properties);
    const resolved = isPermissionResolved(properties);
    if (resolved) {
      return { request: null, resolvedPermissionId: permissionId };
    }

    return {
      request: {
        permissionId,
        title: "Permission requested",
        details,
        createdAt: new Date().toISOString(),
      },
      resolvedPermissionId: null,
    };
  } catch {
    return { request: null, resolvedPermissionId: null };
  }
}

export function parseQuestionFromStreamData(data: string): {
  request: QuestionRequest | null;
  resolvedQuestionId: string | null;
} {
  try {
    const wrapper = JSON.parse(data) as { event?: string[] };
    const lines = Array.isArray(wrapper.event) ? wrapper.event : [];
    const payload = extractJsonFromEventLines(lines);
    if (!payload) {
      return { request: null, resolvedQuestionId: null };
    }

    // Unwrap GlobalEvent envelope
    const inner = (payload.payload as Record<string, unknown>) || payload;

    const typeValue = String(inner.type || "").toLowerCase();
    const properties =
      inner.properties && typeof inner.properties === "object"
        ? (inner.properties as Record<string, unknown>)
        : inner;

    if (typeValue === "question.asked") {
      const id = typeof properties.id === "string" ? properties.id : null;
      const sessionID =
        typeof properties.sessionID === "string"
          ? properties.sessionID
          : typeof properties.sessionId === "string"
            ? properties.sessionId
            : null;
      const questions = Array.isArray(properties.questions) ? properties.questions : null;
      if (!id || !sessionID || !questions || questions.length === 0) {
        return { request: null, resolvedQuestionId: null };
      }
      return {
        request: {
          id,
          sessionID,
          questions: questions as QuestionRequest["questions"],
          tool: properties.tool && typeof properties.tool === "object" ? (properties.tool as QuestionRequest["tool"]) : undefined,
        },
        resolvedQuestionId: null,
      };
    }

    if (typeValue === "question.replied" || typeValue === "question.rejected") {
      const requestId =
        typeof properties.requestID === "string"
          ? properties.requestID
          : typeof properties.requestId === "string"
            ? properties.requestId
            : typeof properties.id === "string"
              ? properties.id
              : null;
      return { request: null, resolvedQuestionId: requestId };
    }
  } catch {
    // ignore malformed event frames
  }

  return { request: null, resolvedQuestionId: null };
}

export type StreamEventClassification = {
  hasMessageUpdate: boolean;
  hasQuestionUpdate: boolean;
  hasApprovalUpdate: boolean;
  hasPartDelta: boolean;
  hasPartUpdate: boolean;
  hasPartRemove: boolean;
  hasCompactionUpdate: boolean;
  hasSessionUpdate: boolean;
  hasTodoUpdate: boolean;
  hasDiffUpdate: boolean;
  hasMessageDelete: boolean;
  isHeartbeat: boolean;
  rawEventType: string | null;
};

export function classifyStreamEvent(data: string): StreamEventClassification {
  const result: StreamEventClassification = {
    hasMessageUpdate: false,
    hasQuestionUpdate: false,
    hasApprovalUpdate: false,
    hasPartDelta: false,
    hasPartUpdate: false,
    hasPartRemove: false,
    hasCompactionUpdate: false,
    hasSessionUpdate: false,
    hasTodoUpdate: false,
    hasDiffUpdate: false,
    hasMessageDelete: false,
    isHeartbeat: false,
    rawEventType: null,
  };

  try {
    const wrapper = JSON.parse(data) as { event?: string[]; type?: string };

    const rawEvents = Array.isArray(wrapper.event) ? wrapper.event : [];
    for (const raw of rawEvents) {
      if (!raw.startsWith("event: ")) continue;
      const eventType = raw.slice(7).trim();
      result.rawEventType = eventType;

      if (eventType === "heartbeat") {
        result.isHeartbeat = true;
      } else if (eventType.includes("permission")) {
        result.hasApprovalUpdate = true;
      } else if (eventType === "question.asked" || eventType === "question.replied" || eventType === "question.rejected") {
        result.hasQuestionUpdate = true;
      } else if (eventType === "message.part.delta") {
        result.hasPartDelta = true;
      } else if (eventType === "message.part.updated") {
        result.hasPartUpdate = true;
      } else if (eventType === "message.part.removed") {
        result.hasPartRemove = true;
      } else if (eventType === "message.updated") {
        result.hasMessageUpdate = true;
      } else if (eventType === "message.removed") {
        result.hasMessageDelete = true;
      } else if (eventType === "todo.updated") {
        result.hasTodoUpdate = true;
      } else if (eventType === "session.diff") {
        result.hasDiffUpdate = true;
      } else if (
        eventType === "session.status" ||
        eventType === "session.idle" ||
        eventType === "session.compacted"
      ) {
        result.hasSessionUpdate = true;
      } else if (
        eventType === "session.next.compaction.started" ||
        eventType === "session.next.compaction.delta" ||
        eventType === "session.next.compaction.ended"
      ) {
        result.hasCompactionUpdate = true;
      }
    }

    if (!result.rawEventType && wrapper.type) {
      const directType = String(wrapper.type).toLowerCase();
      result.rawEventType = directType;
      if (directType === "heartbeat") {
        result.isHeartbeat = true;
      } else if (directType.includes("permission")) {
        result.hasApprovalUpdate = true;
      } else if (directType.startsWith("question.")) {
        result.hasQuestionUpdate = true;
      } else if (directType === "message.part.delta") {
        result.hasPartDelta = true;
      } else if (directType === "message.part.updated") {
        result.hasPartUpdate = true;
      } else if (directType === "message.part.removed") {
        result.hasPartRemove = true;
      } else if (directType === "message.updated") {
        result.hasMessageUpdate = true;
      } else if (directType === "message.removed") {
        result.hasMessageDelete = true;
      } else if (directType === "todo.updated") {
        result.hasTodoUpdate = true;
      } else if (directType === "session.diff") {
        result.hasDiffUpdate = true;
      } else if (
        directType === "session.status" ||
        directType === "session.idle" ||
        directType === "session.compacted"
      ) {
        result.hasSessionUpdate = true;
      } else if (
        directType === "session.next.compaction.started" ||
        directType === "session.next.compaction.delta" ||
        directType === "session.next.compaction.ended"
      ) {
        result.hasCompactionUpdate = true;
      }
    }
  } catch {
    // ignore malformed events
  }

  return result;
}

export type MessagePartPayload = {
  sessionID: string | null;
  messageID: string | null;
  partID: string | null;
  partType: string | null;
  text: string | null;
};

export function extractPayloadFromDataLines(eventLines: string[]): Record<string, unknown> | null {
  const payloadLines = eventLines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  if (payloadLines.length === 0) return null;

  const payload = payloadLines.join("\n");
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    // Unwrap GlobalEvent envelope: { directory, project?, workspace?, payload: { type, properties } }
    const inner = parsed.payload as Record<string, unknown> | undefined;
    return (inner && typeof inner.type === "string") ? inner : parsed;
  } catch {
    return null;
  }
}

export type ExtractedPart = {
  sessionID: string | null;
  part: Record<string, unknown> | null;
  rawEventType: string | null;
};

export type ExtractedPartRemoval = {
  sessionID: string | null;
  messageID: string | null;
  partID: string | null;
  rawEventType: string | null;
};

export function extractPartFromEvent(eventLines: string[]): ExtractedPart | null {
  const payload = extractPayloadFromDataLines(eventLines);
  if (!payload) return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  if (!properties) return null;

  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
  const msgType = typeof payload.type === "string" ? payload.type : null;

  const part = properties.part as Record<string, unknown> | undefined;
  if (part) {
    return { sessionID, part, rawEventType: msgType };
  }

  if (msgType === "message.part.delta") {
    const deltaPart: Record<string, unknown> = {
      id: properties.partID,
      messageID: properties.messageID,
      type: properties.field || "text",
      text: properties.delta,
    };
    return { sessionID, part: deltaPart, rawEventType: msgType };
  }

  return null;
}

export function extractPartRemovalFromEvent(eventLines: string[]): ExtractedPartRemoval | null {
  const payload = extractPayloadFromDataLines(eventLines);
  if (!payload || payload.type !== "message.part.removed") return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  if (!properties) return null;

  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
  const part = properties.part as Record<string, unknown> | undefined;
  const messageID =
    typeof properties.messageID === "string"
      ? properties.messageID
      : part && typeof part.messageID === "string"
        ? part.messageID
        : null;
  const partID =
    typeof properties.partID === "string"
      ? properties.partID
      : part && typeof part.id === "string"
        ? part.id
        : null;
  const rawEventType = typeof payload.type === "string" ? payload.type : null;

  return {
    sessionID,
    messageID,
    partID,
    rawEventType,
  };
}

export function extractMessageFromEvent(eventLines: string[]): Record<string, unknown> | null {
  const payload = extractPayloadFromDataLines(eventLines);
  if (!payload) return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  if (!properties) return null;

  return (properties.info || properties) as Record<string, unknown> | null;
}

export function extractTodosFromEvent(eventLines: string[]): { sessionID: string | null; todos: unknown[] } | null {
  const payload = extractPayloadFromDataLines(eventLines);
  if (!payload) return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  if (!properties) return null;

  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
  const todos = Array.isArray(properties.todos) ? properties.todos : [];
  return { sessionID, todos };
}

export function extractDiffFromEvent(eventLines: string[]): { sessionID: string | null; diff: unknown[] } | null {
  const payload = extractPayloadFromDataLines(eventLines);
  if (!payload) return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  if (!properties) return null;

  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
  const diff = Array.isArray(properties.diff) ? properties.diff : [];
  return { sessionID, diff };
}

export function extractSessionStatusFromEvent(eventLines: string[]): { sessionID: string | null; status: Record<string, unknown> | null } | null {
  const payload = extractPayloadFromDataLines(eventLines);
  if (!payload) return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  if (!properties) return null;

  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
  const status = properties.status as Record<string, unknown> | undefined;
  return { sessionID, status: status || null };
}

export function extractMessagePartText(eventLines: string[]): MessagePartPayload | null {
  const payloadLines = eventLines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  if (payloadLines.length === 0) {
    return null;
  }

  const raw = payloadLines.join("\n");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Unwrap GlobalEvent envelope
    const wrapper = (parsed.payload as Record<string, unknown>) || parsed;

    // Try the properties.part path (message.part.updated)
    const part = wrapper.part as Record<string, unknown> | undefined;
    if (part) {
      const sessionID = typeof wrapper.sessionID === "string" ? wrapper.sessionID : null;
      const messageID = typeof part.messageID === "string" ? part.messageID : null;
      const partID = typeof part.id === "string" ? part.id : null;
      const partType = typeof part.type === "string" ? part.type : null;
      const text = typeof part.text === "string" ? part.text : null;
      return { sessionID, messageID, partID, partType, text };
    }

    // Try the nested properties path (common in events)
    const properties = wrapper.properties as Record<string, unknown> | undefined;
    if (properties) {
      const msgType = typeof wrapper.type === "string" ? wrapper.type : null;
      if (msgType === "message.part.delta") {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
        const messageID = typeof properties.messageID === "string" ? properties.messageID : null;
        const partID = typeof properties.partID === "string" ? properties.partID : null;
        const field = typeof properties.field === "string" ? properties.field : null;
        const delta = typeof properties.delta === "string" ? properties.delta : null;
        return { sessionID, messageID, partID, partType: field, text: delta };
      }

      const partObj = properties.part as Record<string, unknown> | undefined;
      if (partObj) {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
        const messageID = typeof partObj.messageID === "string" ? partObj.messageID : null;
        const partID = typeof partObj.id === "string" ? partObj.id : null;
        const partType = typeof partObj.type === "string" ? partObj.type : null;
        const text = typeof partObj.text === "string" ? partObj.text : null;
        return { sessionID, messageID, partID, partType, text };
      }
    }

    return null;
  } catch {
    return null;
  }
}
