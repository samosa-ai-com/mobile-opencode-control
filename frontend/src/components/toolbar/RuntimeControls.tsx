import React, { useMemo } from "react";
import type { ProjectSession, RuntimeAgentOption, RuntimeModelOption } from "../../types";
import { formatSessionTimestamp } from "../../utils/formatting";
import { sortSessionsForDisplay } from "../../utils/projectUtils";

export function RuntimeControls({
  models,
  agents,
  sessions,
  activeSessionId,
  selectedModel,
  selectedAgent,
  globalDefaultModel,
  saving,
  sessionLoading,
  sessionSwitching,
  compacting,
  error,
  reloading,
  reloadMessage,
  onReload,
  onModelChange,
  onAgentChange,
  onSessionChange,
  onSessionCreate,
  onSessionDelete,
  onCompact,
}: {
  models: RuntimeModelOption[];
  agents: RuntimeAgentOption[];
  sessions: ProjectSession[];
  activeSessionId: string | null;
  selectedModel: string | null;
  selectedAgent: string | null;
  globalDefaultModel: string | null;
  saving: boolean;
  sessionLoading: boolean;
  sessionSwitching: boolean;
  compacting: boolean;
  error: string | null;
  reloading: boolean;
  reloadMessage: string | null;
  onReload: () => void;
  onModelChange: (value: string | null) => void;
  onAgentChange: (value: string | null) => void;
  onSessionChange: (value: string) => void;
  onSessionCreate: () => void;
  onSessionDelete: () => void;
  onCompact: () => void;
}) {
  const sortedSessions = useMemo(
    () => sortSessionsForDisplay(sessions, activeSessionId),
    [sessions, activeSessionId]
  );

  const defaultModel = useMemo(
    () => {
      if (globalDefaultModel) {
        const found = models.find((m) => m.id === globalDefaultModel);
        if (found) return found;
      }
      return models.find((m) => m.isDefault) ?? null;
    },
    [models, globalDefaultModel]
  );

  const defaultAgent = useMemo(
    () => {
      const buildAgent = agents.find((a) => a.id === "build");
      if (buildAgent) return buildAgent;
      return agents.length > 0 ? agents[0] : null;
    },
    [agents]
  );

  function handleSessionChange(value: string) {
    if (value === "__new__") {
      onSessionCreate();
      return;
    }
    if (value) {
      onSessionChange(value);
    }
  }

  const activeIdInList =
    activeSessionId !== null && sortedSessions.some((s) => s.id === activeSessionId);
  const sessionSelectValue = activeIdInList ? (activeSessionId as string) : "";

  return (
    <div className="runtime-controls">
      <label>
        <span style={{ display: "inline-flex", gap: "8px", alignItems: "center" }}>
          Model
          <button
            type="button"
            className="secondary-button"
            onClick={onReload}
            disabled={reloading}
            style={{ padding: "4px 10px", fontSize: "12px", minHeight: "28px" }}
          >
            {reloading ? "↻ Reloading…" : "↻ Reload"}
          </button>
        </span>
        <select
          value={selectedModel ?? ""}
          onChange={(event) => onModelChange(event.currentTarget.value || null)}
          disabled={saving}
        >
          <option value="">{defaultModel ? `${defaultModel.providerName} / ${defaultModel.name}` : "Server default"}</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.providerName} / {model.name}
              {model.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Agent</span>
        <select
          value={selectedAgent ?? ""}
          onChange={(event) => onAgentChange(event.currentTarget.value || null)}
          disabled={saving}
        >
          <option value="">{defaultAgent ? defaultAgent.id : "Server default"}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.id}
            </option>
          ))}
        </select>
      </label>
      <div className="session-section">
        <span className="session-section-label">Sessions</span>
        <select
          value={sessionSelectValue}
          onChange={(event) => handleSessionChange(event.currentTarget.value)}
          disabled={sessionLoading || sessionSwitching}
          aria-label="Active session"
        >
          {sortedSessions.length === 0 ? (
            <option value="" disabled>{sessionLoading ? "Loading..." : "No session"}</option>
          ) : (
            <>
              {!activeIdInList ? (
                <option value="" disabled>
                  {sessionLoading ? "Loading..." : "Select session…"}
                </option>
              ) : null}
              {sortedSessions.map((session) => {
                const label = session.title || "Untitled session";
                const ts = formatSessionTimestamp(session.updatedAt ?? session.createdAt);
                return (
                  <option key={session.id} value={session.id}>
                    {label} — {ts}
                  </option>
                );
              })}
              <option value="__new__">+ New session</option>
            </>
          )}
        </select>
        <div className="session-actions-row">
          <button
            type="button"
            className="secondary-button session-compact-button"
            onClick={onCompact}
            disabled={sessionLoading || sessionSwitching || !activeSessionId || compacting}
          >
            {compacting ? "Compacting..." : "Compact"}
          </button>
          <button
            type="button"
            className="secondary-button session-delete-button"
            onClick={onSessionDelete}
            disabled={sessionLoading || sessionSwitching || !activeSessionId}
          >
            Delete
          </button>
        </div>
      </div>
      {saving ? <small>Saving runtime...</small> : null}
      {error ? <small className="runtime-error">{error}</small> : null}
      {reloadMessage ? <small>{reloadMessage}</small> : null}
    </div>
  );
}
