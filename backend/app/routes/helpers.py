import json
import os
import ipaddress
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from flask import current_app, jsonify

from ..db import db
from ..models import AppSetting, Project, ScheduledTask, ScheduledTaskRun, TimelineEvent
from ..scheduler import TASK_TYPES, calculate_next_run, next_cron_runs, parse_cron_expression

__all__ = [
    "_utc_now",
    "_project_to_dict",
    "_query_projects_with_sessions",
    "_resolve_visible_active_project_id",
    "_task_to_dict",
    "_task_run_to_dict",
    "_parse_optional_datetime",
    "_task_metrics",
    "_timeline_event_to_dict",
    "_datetime_from_epoch_ms",
    "_ensure_utc",
    "_normalize_project_path",
    "_resolve_project_relative_path",
    "_collect_project_tree_entries",
    "_list_project_directory_entries",
    "_get_setting",
    "_set_setting",
    "_delete_setting",
    "_project_setting_key",
    "_get_project_pending_approvals",
    "_set_project_pending_approvals",
    "_clear_project_pending_approvals",
    "_get_project_pending_questions",
    "_set_project_pending_questions",
    "_clear_project_pending_questions",
    "_get_notification_settings",
    "_set_notification_settings",
    "_send_ntfy_notification",
    "_get_project_runtime_selection",
    "_session_matches_project",
    "_clear_project_session_cache",
    "_extract_text",
    "_local_message",
    "_message_to_dict",
    "_session_to_dict",
    "_list_project_sessions",
    "_latest_project_session",
    "_resolve_project_session",
    "_ensure_project_session",
    "_sort_sessions_desc",
    "_extract_data_payload",
    "_extract_json_event_payload",
    "_find_permission_id",
    "_is_permission_resolved",
    "_parse_permission_event",
    "_parse_question_event",
    "_update_pending_approvals_from_event",
    "_update_pending_questions_from_event",
    "_event_matches_session",
    "_provider_headers",
    "_has_external_stt_provider",
    "_has_external_tts_provider",
    "LOCAL_SESSION_COMMANDS",
    "_apply_task_payload",
    "_bad_gateway",
    "_internal_error",
    "_validate_ntfy_topic_url",
]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)

def _project_to_dict(project: Project) -> dict:
    return {
        "id": str(project.id),
        "name": project.name,
        "path": project.path,
        "lastSessionId": project.last_session_id,
        "lastMessagePreview": project.last_message_preview,
        "sessionStatus": project.session_status,
        "hasScheduledTask": bool(project.has_scheduled_task),
        "createdAt": project.created_at.isoformat(),
        "updatedAt": project.updated_at.isoformat(),
        "lastActivityAt": project.last_activity_at.isoformat(),
    }

def _query_projects_with_sessions(query):
    return query.filter(
        Project.last_session_id.isnot(None),
        Project.last_session_id != "",
    )

def _resolve_visible_active_project_id(projects: list[Project]) -> str | None:
    active_project_id = _get_setting("active_project_id")
    visible_project_ids = {str(project.id) for project in projects}
    if active_project_id and active_project_id in visible_project_ids:
        return active_project_id
    if not projects:
        return None
    return str(projects[0].id)

def _task_to_dict(task: ScheduledTask) -> dict:
    return {
        "id": str(task.id),
        "projectId": str(task.project_id),
        "name": task.name,
        "description": task.description,
        "instruction": task.instruction,
        "taskType": task.task_type,
        "cronExpression": task.cron_expression,
        "onceRunAt": task.once_run_at.isoformat() if task.once_run_at else None,
        "intervalMinutes": task.interval_minutes,
        "timezone": task.timezone,
        "model": task.model,
        "agent": task.agent,
        "enabled": bool(task.enabled),
        "startsAt": task.starts_at.isoformat() if task.starts_at else None,
        "endsAt": task.ends_at.isoformat() if task.ends_at else None,
        "maxRuns": task.max_runs,
        "runTimeoutMinutes": task.run_timeout_minutes,
        "heartbeatEnabled": bool(task.heartbeat_enabled),
        "goalDefinition": task.goal_definition,
        "autoDisableOnGoalMet": bool(task.auto_disable_on_goal_met),
        "retryCount": task.retry_count,
        "retryBackoffMinutes": task.retry_backoff_minutes,
        "notificationUrl": task.notification_url,
        "persistentSessionId": task.persistent_session_id,
        "totalRuns": task.total_runs,
        "nextRunAt": task.next_run_at.isoformat() if task.next_run_at else None,
        "lastRunAt": task.last_run_at.isoformat() if task.last_run_at else None,
        "lastStatus": task.last_status,
        "lastError": task.last_error,
        "createdAt": task.created_at.isoformat(),
        "updatedAt": task.updated_at.isoformat(),
    }

def _task_run_to_dict(run: ScheduledTaskRun) -> dict:
    return {
        "id": str(run.id),
        "taskId": str(run.task_id),
        "projectId": str(run.project_id),
        "status": run.status,
        "sessionId": run.session_id,
        "trigger": run.trigger,
        "startedAt": run.started_at.isoformat() if run.started_at else None,
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
        "heartbeatLoaded": bool(run.heartbeat_loaded),
        "runNumber": run.run_number,
        "modelUsed": run.model_used,
        "agentUsed": run.agent_used,
        "timeoutUsed": run.timeout_used,
        "goalAttempted": bool(run.goal_attempted),
        "goalMet": run.goal_met,
        "goalOutput": run.goal_output,
        "retryAttempt": run.retry_attempt,
        "outputPreview": run.output_preview,
        "error": run.error,
    }

def _parse_optional_datetime(value) -> datetime | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError("datetime value must be an ISO string")
    normalized = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)

def _task_metrics(task: ScheduledTask) -> dict:
    runs = ScheduledTaskRun.query.filter_by(task_id=task.id).all()
    completed = [run for run in runs if run.status in {"completed", "goal_met"}]
    finished = [run for run in runs if run.finished_at and run.started_at]
    avg_runtime_seconds = None
    if finished:
        durations = [(_ensure_utc(run.finished_at) - _ensure_utc(run.started_at)).total_seconds() for run in finished]
        avg_runtime_seconds = sum(durations) / len(durations)
    return {
        "totalRuns": len(runs),
        "successRate": (len(completed) / len(runs)) if runs else None,
        "avgRuntimeSeconds": avg_runtime_seconds,
        "lastOutcomes": [run.status for run in sorted(runs, key=lambda item: item.started_at or _utc_now(), reverse=True)[:10]],
    }

LOCAL_SESSION_COMMANDS = {
    "stop": "Stop the current agent execution for this project session.",
    "abort": "Alias for /stop.",
    "compact": "Compact the session by summarizing the conversation history.",
    "summarize": "Alias for /compact.",
}

def _timeline_event_to_dict(event: TimelineEvent) -> dict:
    payload = {}
    try:
        parsed = json.loads(event.payload_json)
        if isinstance(parsed, dict):
            payload = parsed
    except Exception:
        payload = {}

    return {
        "id": str(event.id),
        "projectId": str(event.project_id),
        "eventType": event.event_type,
        "createdAt": event.created_at.isoformat(),
        "payload": payload,
    }

def _datetime_from_epoch_ms(value: object) -> datetime | None:
    if not isinstance(value, (int, float)):
        return None
    if value <= 0:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc)

def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)

def _normalize_project_path(path: str) -> str:
    return os.path.realpath(os.path.abspath(path.strip()))

def _log_route_exception(message: str, exc: Exception) -> None:
    current_app.logger.exception("%s: %s", message, exc)

def _error_response(message: str, status_code: int, exc: Exception):
    _log_route_exception(message, exc)
    return jsonify({"error": message}), status_code

def _bad_gateway(message: str, exc: Exception):
    return _error_response(message, 502, exc)

def _internal_error(message: str, exc: Exception):
    return _error_response(message, 500, exc)

def _path_uses_symlink(project_root: Path, candidate: Path) -> bool:
    try:
        relative_candidate = candidate.relative_to(project_root)
    except ValueError:
        return True

    current = project_root
    for part in relative_candidate.parts:
        current = current / part
        if current.is_symlink():
            return True
        if not current.exists():
            break
    return False

def _resolve_project_relative_path(
    project: Project,
    relative_path: str,
    *,
    allow_root: bool = False,
) -> Path:
    project_root = Path(_normalize_project_path(project.path)).resolve()
    normalized_relative = os.path.normpath((relative_path or "").strip() or ".")
    candidate_relative = Path(normalized_relative)
    if candidate_relative.is_absolute() or ".." in candidate_relative.parts:
        raise ValueError("Path is outside project root")
    candidate = project_root / candidate_relative

    if candidate == project_root:
        if allow_root:
            return candidate
        raise ValueError("A file path is required")

    if _path_uses_symlink(project_root, candidate):
        raise ValueError("Path traverses a symbolic link")

    return candidate

def _collect_project_tree_entries(
    project: Project, max_entries: int = 12000
) -> tuple[list[dict], bool]:
    root = _resolve_project_relative_path(project, "", allow_root=True)
    entries: list[dict] = []
    seen_paths: set[str] = set()
    truncated = False
    stack: list[tuple[str, int]] = [(root.as_posix(), 0)]

    while stack:
        current_dir_path, depth = stack.pop()
        try:
            with os.scandir(current_dir_path) as iterator:
                children = sorted(
                    [entry for entry in iterator],
                    key=lambda item: (
                        not item.is_dir(follow_symlinks=False),
                        item.name.lower(),
                    ),
                )
        except OSError:
            continue

        for child in children:
            try:
                child_path = Path(child.path)
                resolved = child_path.resolve()
            except OSError:
                continue

            if resolved != root and root not in resolved.parents:
                continue

            try:
                child_stat = resolved.stat()
            except OSError:
                continue

            relative = child_path.relative_to(root).as_posix()
            if relative in seen_paths:
                continue
            seen_paths.add(relative)

            is_dir = child.is_dir(follow_symlinks=False)
            entries.append(
                {
                    "path": relative,
                    "name": child.name,
                    "isDir": is_dir,
                    "size": 0 if is_dir else int(child_stat.st_size),
                    "modifiedAt": datetime.fromtimestamp(
                        child_stat.st_mtime, tz=timezone.utc
                    ).isoformat(),
                    "depth": depth,
                }
            )

            if len(entries) >= max_entries:
                truncated = True
                break

            if is_dir:
                stack.append((child.path, depth + 1))

        if truncated:
            break

    return entries, truncated

def _list_project_directory_entries(
    project: Project,
    directory: str,
    max_entries: int = 2500,
) -> tuple[Path, list[dict], bool]:
    root = _resolve_project_relative_path(project, "", allow_root=True)
    target_dir = _resolve_project_relative_path(project, directory, allow_root=True)
    if not target_dir.exists() or not target_dir.is_dir():
        raise ValueError("Directory not found")

    entries: list[dict] = []
    truncated = False
    base_depth = 0 if target_dir == root else len(target_dir.relative_to(root).parts)

    try:
        with os.scandir(target_dir) as iterator:
            children = sorted(
                [entry for entry in iterator],
                key=lambda item: (
                    not item.is_dir(follow_symlinks=False),
                    item.name.lower(),
                ),
            )
    except OSError as exc:
        raise ValueError(f"Unable to list directory: {exc}") from exc

    for child in children:
        child_path = Path(child.path)
        try:
            resolved = child_path.resolve()
            if resolved != root and root not in resolved.parents:
                continue
            child_stat = resolved.stat()
            is_dir = child.is_dir(follow_symlinks=False)
            relative = child_path.relative_to(root).as_posix()
        except OSError:
            continue

        entries.append(
            {
                "path": relative,
                "name": child.name,
                "isDir": is_dir,
                "size": 0 if is_dir else int(child_stat.st_size),
                "modifiedAt": datetime.fromtimestamp(
                    child_stat.st_mtime, tz=timezone.utc
                ).isoformat(),
                "depth": base_depth,
            }
        )

        if len(entries) >= max_entries:
            truncated = True
            break

    return target_dir, entries, truncated

def _get_setting(key: str, default: str | None = None) -> str | None:
    setting = AppSetting.query.filter_by(key=key).first()
    if setting is None:
        return default
    return setting.value

def _set_setting(key: str, value: str) -> None:
    setting = AppSetting.query.filter_by(key=key).first()
    if setting is None:
        setting = AppSetting(key=key, value=value)
        db.session.add(setting)
    else:
        setting.value = value

def _delete_setting(key: str) -> None:
    setting = AppSetting.query.filter_by(key=key).first()
    if setting is not None:
        db.session.delete(setting)

def _project_setting_key(project_id: int, suffix: str) -> str:
    return f"project:{project_id}:{suffix}"

def _get_project_pending_approvals(
    project_id: int, session_id: str | None = None
) -> list[dict]:
    raw = _get_setting(_project_setting_key(project_id, "pending_approvals"), "[]") or "[]"
    try:
        parsed = json.loads(raw)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    approvals: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        permission_id = str(item.get("permissionId") or "").strip()
        if not permission_id:
            continue
        approvals.append(
            {
                "permissionId": permission_id,
                "sessionId": str(item.get("sessionId") or "").strip() or None,
                "title": str(item.get("title") or "Permission requested").strip()
                or "Permission requested",
                "details": str(item.get("details") or "").strip(),
                "createdAt": str(item.get("createdAt") or _utc_now().isoformat()),
            }
        )
    if session_id is None:
        return approvals
    return [
        item
        for item in approvals
        if str(item.get("sessionId") or "").strip() == session_id
    ]

def _set_project_pending_approvals(project_id: int, approvals: list[dict]) -> None:
    _set_setting(
        _project_setting_key(project_id, "pending_approvals"),
        json.dumps(approvals),
    )

def _clear_project_pending_approvals(project_id: int) -> None:
    _delete_setting(_project_setting_key(project_id, "pending_approvals"))

def _get_project_pending_questions(
    project_id: int, session_id: str | None = None
) -> list[dict]:
    raw = _get_setting(_project_setting_key(project_id, "pending_questions"), "[]") or "[]"
    try:
        parsed = json.loads(raw)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []

    questions: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        question_id = str(item.get("id") or "").strip()
        if not question_id:
            continue
        questions_raw = item.get("questions")
        if not isinstance(questions_raw, list) or len(questions_raw) == 0:
            continue
        questions.append(item)

    if session_id is None:
        return questions

    return [
        item
        for item in questions
        if str(item.get("sessionID") or item.get("sessionId") or "").strip()
        == session_id
    ]

def _set_project_pending_questions(project_id: int, questions: list[dict]) -> None:
    _set_setting(
        _project_setting_key(project_id, "pending_questions"),
        json.dumps(questions),
    )

def _clear_project_pending_questions(project_id: int) -> None:
    _delete_setting(_project_setting_key(project_id, "pending_questions"))

def _get_notification_settings() -> dict[str, str]:
    channel = (_get_setting("notification_channel", "browser") or "browser").strip().lower()
    if channel not in {"browser", "ntfy", "both", "off"}:
        channel = "browser"
    topic_url = (_get_setting("notification_ntfy_topic_url", "") or "").strip()
    return {"channel": channel, "ntfyTopicUrl": topic_url}

def _host_is_public(hostname: str) -> bool:
    if not hostname or hostname.lower() == "localhost":
        return False
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return True
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )

_NTFY_TOPIC_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._~-]+$")

def _trusted_ntfy_base_url() -> str:
    configured_topic_url = os.getenv("NOTIFICATION_NTFY_TOPIC_URL", "").strip()
    if configured_topic_url:
        parsed = urlparse(configured_topic_url)
        if (
            parsed.scheme == "https"
            and parsed.netloc
            and not parsed.username
            and not parsed.password
        ):
            return f"https://{parsed.netloc}"
    return "https://ntfy.sh"

def _trusted_ntfy_hostname() -> str:
    return urlparse(_trusted_ntfy_base_url()).hostname or "ntfy.sh"

def _normalize_ntfy_topic_path(topic_url: str) -> str:
    parsed = urlparse(topic_url.strip())
    topic_segments = [segment for segment in parsed.path.split("/") if segment]
    if not topic_segments:
        raise ValueError("ntfy topic URL must include a topic path")
    if not all(_NTFY_TOPIC_SEGMENT_RE.fullmatch(segment) for segment in topic_segments):
        raise ValueError("ntfy topic URL contains invalid topic characters")
    return "/".join(topic_segments)

def _validate_ntfy_topic_url(topic_url: str) -> str:
    normalized = topic_url.strip()
    if not normalized:
        return ""

    parsed = urlparse(normalized)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("ntfy topic URL must be a valid https URL")
    if parsed.username or parsed.password:
        raise ValueError("ntfy topic URL must not include credentials")
    hostname = (parsed.hostname or "").lower()
    if not _host_is_public(hostname):
        raise ValueError("ntfy topic URL must use a public host")
    if hostname != _trusted_ntfy_hostname():
        raise ValueError("ntfy topic URL must use the configured host")
    if parsed.port not in (None, 443):
        raise ValueError("ntfy topic URL must use the default https port")
    return f"{_trusted_ntfy_base_url()}/{_normalize_ntfy_topic_path(normalized)}"

def _set_notification_settings(channel: str, ntfy_topic_url: str) -> None:
    _set_setting("notification_channel", channel)
    validated_topic_url = _validate_ntfy_topic_url(ntfy_topic_url)
    if validated_topic_url:
        _set_setting("notification_ntfy_topic_url", validated_topic_url)
    else:
        _delete_setting("notification_ntfy_topic_url")

def _send_ntfy_notification(topic_url: str, title: str, message: str) -> None:
    response = requests.post(
        _validate_ntfy_topic_url(topic_url),
        data=message.encode("utf-8"),
        headers={
            "Title": title,
            "Priority": "4",
            "Tags": "robot",
            "Markdown": "yes",
        },
        timeout=10,
    )
    response.raise_for_status()

def _get_project_runtime_selection(project_id: int) -> dict[str, str | None]:
    return {
        "model": _get_setting(_project_setting_key(project_id, "model")),
        "agent": _get_setting(_project_setting_key(project_id, "agent")),
    }

def _session_matches_project(
    project: Project,
    session: dict,
) -> bool:
    directory = session.get("directory")
    if not isinstance(directory, str) or not directory.strip():
        return False

    return _normalize_project_path(directory) == _normalize_project_path(project.path)

def _clear_project_session_cache(project_id: int) -> None:
    _delete_setting(_project_setting_key(project_id, "sessions"))

def _extract_text(parts: list[dict]) -> str:
    chunks: list[str] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            chunks.append(part["text"])
    return "\n".join(chunks).strip()

def _local_message(text: str, role: str = "assistant") -> dict:
    timestamp = _utc_now().isoformat()
    return {
        "id": f"local-{int(_utc_now().timestamp() * 1000)}",
        "role": role,
        "createdAt": timestamp,
        "text": text,
        "parts": [{"type": "text", "text": text}],
    }

def _message_to_dict(message: dict) -> dict:
    info = message.get("info") if isinstance(message, dict) else {}
    parts = message.get("parts") if isinstance(message, dict) else []
    if not isinstance(parts, list):
        parts = []

    time_info = info.get("time") if isinstance(info, dict) and isinstance(info.get("time"), dict) else {}
    message_time = message.get("time") if isinstance(message.get("time"), dict) else {}
    created_at = (
        _datetime_from_epoch_ms(time_info.get("created"))
        or _datetime_from_epoch_ms(message_time.get("created"))
    )
    text = _extract_text(parts)
    tokens = info.get("tokens") if isinstance(info.get("tokens"), dict) else None
    token_data = None
    if tokens:
        cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
        token_data = {
            "input": int(tokens.get("input") or 0),
            "output": int(tokens.get("output") or 0),
            "reasoning": int(tokens.get("reasoning") or 0),
            "cacheRead": int(cache.get("read") or 0),
            "cacheWrite": int(cache.get("write") or 0),
        }
    return {
        "id": str((info or {}).get("id") or ""),
        "role": (info or {}).get("role") or "assistant",
        "createdAt": (info or {}).get("createdAt")
        or (created_at.isoformat() if created_at else None)
        or _utc_now().isoformat(),
        "text": text,
        "parts": parts,
        "tokens": token_data,
        "mode": str((info or {}).get("mode") or ""),
        "summary": bool((info or {}).get("summary")),
    }

def _session_to_dict(
    session: dict,
    active_session_id: str | None = None,
    ownership_source: str | None = None,
    effective_project_path: str | None = None,
) -> dict:
    time_info = session.get("time") if isinstance(session.get("time"), dict) else {}
    created_at = _datetime_from_epoch_ms(time_info.get("created"))
    updated_at = _datetime_from_epoch_ms(time_info.get("updated"))
    session_id = str(session.get("id") or "")
    title = str(session.get("title") or "").strip()
    slug = str(session.get("slug") or "").strip()
    summary = session.get("summary") if isinstance(session.get("summary"), dict) else {}

    return {
        "id": session_id,
        "title": title or slug or session_id,
        "slug": slug,
        "directory": str(session.get("directory") or ""),
        "version": str(session.get("version") or "").strip(),
        "createdAt": created_at.isoformat() if created_at else None,
        "updatedAt": updated_at.isoformat() if updated_at else None,
        "summary": {
            "files": int(summary.get("files") or 0),
            "additions": int(summary.get("additions") or 0),
            "deletions": int(summary.get("deletions") or 0),
        },
        "isActive": bool(active_session_id and session_id == active_session_id),
        "ownershipSource": ownership_source,
        "effectiveProjectPath": effective_project_path,
    }

def _list_project_sessions(
    project: Project, opencode_client, limit: int = 200
) -> list[dict]:
    sessions = opencode_client.list_sessions(limit=limit, directory=project.path)
    matching_sessions = [
        session for session in sessions if _session_matches_project(project, session)
    ]
    return _sort_sessions_desc(matching_sessions)

def _latest_project_session(project: Project, opencode_client) -> str | None:
    sessions = opencode_client.list_sessions(limit=1, directory=_normalize_project_path(project.path))
    for session in sessions:
        if _session_matches_project(project, session):
            return str(session.get("id") or "").strip()
    return None

def _resolve_project_session(
    project: Project,
    opencode_client,
    session_id: str | None = None,
    create_if_missing: bool = True,
) -> str:
    project_path = _normalize_project_path(project.path)

    candidate_session_id = (
        str(session_id).strip()
        if isinstance(session_id, str) and session_id.strip()
        else None
    ) or project.last_session_id

    had_candidate = candidate_session_id is not None

    if candidate_session_id:
        try:
            session = opencode_client.get_session(candidate_session_id)
            if _session_matches_project(project, session):
                # Check if a newer session exists for this directory (e.g., created by TUI)
                latest = _latest_project_session(project, opencode_client)
                if latest and latest != candidate_session_id:
                    project.last_session_id = latest
                    project.last_activity_at = _utc_now()
                    db.session.commit()
                    return latest
                if project.last_session_id != candidate_session_id:
                    project.last_session_id = candidate_session_id
                    project.last_activity_at = _utc_now()
                    db.session.commit()
                return candidate_session_id
            project.last_session_id = None
        except requests.HTTPError as exc:
            project.last_session_id = None
            db.session.commit()
            if had_candidate:
                raise ValueError("Selected session could not be loaded") from exc

        if session_id:
            db.session.commit()
            raise ValueError("Selected session does not belong to this project")

        db.session.commit()

    existing_sessions = _list_project_sessions(project, opencode_client, limit=200)
    if existing_sessions:
        fallback_session_id = str(existing_sessions[0].get("id") or "").strip()
        if fallback_session_id:
            project.last_session_id = fallback_session_id
            project.last_activity_at = _utc_now()
            db.session.commit()
            return fallback_session_id

    if not create_if_missing:
        raise ValueError("No session selected for this project")

    session = opencode_client.create_session(directory=project_path, title=project.name)
    session_id = session.get("id")
    if not session_id:
        raise ValueError("Unable to create OpenCode session")

    project.last_session_id = str(session_id)
    project.session_status = "idle"
    project.last_activity_at = _utc_now()
    db.session.commit()
    return project.last_session_id

def _ensure_project_session(project: Project, opencode_client) -> str:
    return _resolve_project_session(project, opencode_client, create_if_missing=True)

def _sort_sessions_desc(sessions: list[dict]) -> list[dict]:
    def _session_sort_key(session: dict) -> tuple[float, str]:
        time_info = session.get("time") if isinstance(session.get("time"), dict) else {}
        updated = _datetime_from_epoch_ms(time_info.get("updated"))
        created = _datetime_from_epoch_ms(time_info.get("created"))
        timestamp = updated or created or datetime.fromtimestamp(0, tz=timezone.utc)
        return (timestamp.timestamp(), str(session.get("id") or ""))

    return sorted(sessions, key=_session_sort_key, reverse=True)

def _extract_data_payload(event_lines: list[str]) -> str:
    chunks: list[str] = []
    for line in event_lines:
        if line.startswith("data:"):
            chunks.append(line[5:].strip())
    return "\n".join(chunks).strip()

def _extract_json_event_payload(event_lines: list[str]) -> dict | None:
    payload = _extract_data_payload(event_lines)
    if not payload:
        return None
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return parsed
    return None

def _find_permission_id(value) -> str | None:
    if isinstance(value, str):
        return value.strip() or None

    if isinstance(value, list):
        for item in value:
            found = _find_permission_id(item)
            if found:
                return found
        return None

    if isinstance(value, dict):
        for candidate in (
            value.get("permissionID"),
            value.get("permissionId"),
            value.get("permission_id"),
            value.get("id"),
        ):
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        for item in value.values():
            found = _find_permission_id(item)
            if found:
                return found
    return None

def _is_permission_resolved(value) -> bool:
    if isinstance(value, str):
        lowered = value.lower()
        return (
            "allow" in lowered
            or "deny" in lowered
            or "reject" in lowered
            or "approve" in lowered
        )

    if isinstance(value, list):
        return any(_is_permission_resolved(item) for item in value)

    if isinstance(value, dict):
        response = value.get("response") or value.get("decision") or value.get("action")
        if isinstance(response, str):
            return True
        return any(_is_permission_resolved(item) for item in value.values())

    return False

def _parse_permission_event(event_lines: list[str]) -> tuple[dict | None, str | None]:
    payload = _extract_json_event_payload(event_lines)
    if not payload:
        return None, None

    event_type = str(payload.get("type") or "").lower()
    if "permission" not in event_type:
        return None, None

    properties = payload.get("properties") if isinstance(payload.get("properties"), dict) else payload
    permission_id = _find_permission_id(properties)
    if not permission_id:
        return None, None

    if _is_permission_resolved(properties):
        return None, permission_id

    details = json.dumps(properties)
    return {
        "permissionId": permission_id,
        "title": "Permission requested",
        "details": details,
        "createdAt": _utc_now().isoformat(),
    }, None

def _parse_question_event(event_lines: list[str]) -> tuple[dict | None, str | None]:
    payload = _extract_json_event_payload(event_lines)
    if not payload:
        return None, None

    event_type = str(payload.get("type") or "").lower()
    if event_type == "question.asked":
        properties = (
            payload.get("properties")
            if isinstance(payload.get("properties"), dict)
            else payload
        )
        question_id = str(properties.get("id") or "").strip()
        if not question_id:
            return None, None
        questions_raw = properties.get("questions")
        if not isinstance(questions_raw, list) or len(questions_raw) == 0:
            return None, None
        return dict(properties), None

    if event_type in {"question.replied", "question.rejected"}:
        properties = (
            payload.get("properties")
            if isinstance(payload.get("properties"), dict)
            else payload
        )
        question_id = str(
            properties.get("requestID")
            or properties.get("requestId")
            or properties.get("id")
            or ""
        ).strip()
        if question_id:
            return None, question_id

    return None, None

def _update_pending_approvals_from_event(
    project_id: int, session_id: str, event_lines: list[str]
) -> None:
    request_item, resolved_permission_id = _parse_permission_event(event_lines)
    if request_item is None and resolved_permission_id is None:
        return

    approvals = _get_project_pending_approvals(project_id)
    if resolved_permission_id:
        next_approvals = [
            item
            for item in approvals
            if str(item.get("permissionId") or "") != resolved_permission_id
        ]
    else:
        assert request_item is not None
        request_item["sessionId"] = session_id
        next_approvals = [
            item
            for item in approvals
            if not (
                str(item.get("permissionId") or "") == request_item["permissionId"]
                and str(item.get("sessionId") or "") == session_id
            )
        ]
        next_approvals.append(request_item)

    if next_approvals:
        _set_project_pending_approvals(project_id, next_approvals)
    else:
        _clear_project_pending_approvals(project_id)
    db.session.commit()

def _update_pending_questions_from_event(
    project_id: int, session_id: str, event_lines: list[str]
) -> None:
    question_item, resolved_question_id = _parse_question_event(event_lines)
    if question_item is None and resolved_question_id is None:
        return

    questions = _get_project_pending_questions(project_id)
    if resolved_question_id:
        next_questions = [
            item
            for item in questions
            if str(item.get("id") or "").strip() != resolved_question_id
        ]
    else:
        assert question_item is not None
        if not question_item.get("sessionID"):
            question_item["sessionID"] = session_id
        question_id = str(question_item.get("id") or "").strip()
        next_questions = [
            item for item in questions if str(item.get("id") or "").strip() != question_id
        ]
        next_questions.append(question_item)

    if next_questions:
        _set_project_pending_questions(project_id, next_questions)
    else:
        _clear_project_pending_questions(project_id)
    db.session.commit()

def _event_matches_session(event_lines: list[str], session_id: str) -> bool:
    payload = _extract_data_payload(event_lines)
    if not payload:
        return True

    if session_id in payload:
        return True

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return True

    # Unwrap GlobalEvent envelope: { directory, project?, workspace?, payload: { type, properties: { sessionID, ... } } }
    inner = parsed.get("payload") if isinstance(parsed, dict) else None
    target = inner if (isinstance(inner, dict) and isinstance(inner.get("type"), str)) else parsed

    keys = {"sessionID", "sessionId", "session_id", "session"}

    def _walk(value) -> bool:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in keys and isinstance(item, str):
                    return item == session_id
                if _walk(item):
                    return True
        elif isinstance(value, list):
            for item in value:
                if _walk(item):
                    return True
        return False

    return _walk(target)

def _provider_headers(api_key: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    if api_key and api_key.strip() and api_key.strip().lower() != "not-required":
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    return headers

def _has_external_stt_provider(settings) -> bool:
    return bool(settings.stt_base_url.strip())

def _has_external_tts_provider(settings) -> bool:
    return bool(settings.tts_base_url.strip())

def _apply_task_payload(task: ScheduledTask, project_id: int, body: dict) -> None:
    instruction = str(body.get("instruction") or "").strip()
    if not instruction:
        raise ValueError("Task instruction is required")

    task_type = str(body.get("taskType") or body.get("task_type") or "interval").strip().lower()
    if task_type not in TASK_TYPES:
        raise ValueError("taskType must be interval, cron, once, or goal")

    try:
        interval_minutes = int(body.get("intervalMinutes") or 15)
        max_runs = body.get("maxRuns")
        run_timeout_minutes = body.get("runTimeoutMinutes")
        retry_count = int(body.get("retryCount") or 0)
        retry_backoff_minutes = int(body.get("retryBackoffMinutes") or 5)
    except (TypeError, ValueError):
        raise ValueError("Numeric task fields are invalid")

    if task_type in {"interval", "goal"} and interval_minutes < 5:
        raise ValueError("Minimum task interval is 5 minutes")

    cron_expression = str(body.get("cronExpression") or "").strip() or None
    if task_type == "cron":
        if not cron_expression:
            raise ValueError("cronExpression is required for cron tasks")
        parse_cron_expression(cron_expression)

    once_run_at = _parse_optional_datetime(body.get("onceRunAt"))
    if task_type == "once" and once_run_at is None:
        raise ValueError("onceRunAt is required for one-time tasks")

    timezone_name = str(body.get("timezone") or "UTC").strip() or "UTC"
    if task_type == "cron":
        next_cron_runs(cron_expression or "* * * * *", timezone_name, _utc_now(), 1)

    starts_at = _parse_optional_datetime(body.get("startsAt"))
    ends_at = _parse_optional_datetime(body.get("endsAt"))
    if starts_at and ends_at and starts_at > ends_at:
        raise ValueError("startsAt must be before endsAt")
    if once_run_at and starts_at and once_run_at < starts_at:
        raise ValueError("onceRunAt must be on or after startsAt")
    if once_run_at and ends_at and once_run_at > ends_at:
        raise ValueError("onceRunAt must be on or before endsAt")

    task.project_id = project_id
    task.name = str(body.get("name") or "Scheduled task").strip()[:180]
    task.description = str(body.get("description") or "").strip() or None
    task.instruction = instruction
    task.task_type = task_type
    task.cron_expression = cron_expression
    task.once_run_at = once_run_at
    task.interval_minutes = interval_minutes
    task.timezone = timezone_name
    task.model = str(body.get("model") or "").strip() or None
    task.agent = str(body.get("agent") or "").strip() or None
    task.enabled = bool(body.get("enabled", True))
    task.starts_at = starts_at
    task.ends_at = ends_at
    task.max_runs = int(max_runs) if max_runs not in (None, "") else None
    task.run_timeout_minutes = int(run_timeout_minutes) if run_timeout_minutes not in (None, "") else None
    task.heartbeat_enabled = bool(body.get("heartbeatEnabled", True))
    task.goal_definition = str(body.get("goalDefinition") or "").strip() or None
    task.auto_disable_on_goal_met = bool(body.get("autoDisableOnGoalMet", True))
    task.retry_count = max(retry_count, 0)
    task.retry_backoff_minutes = max(retry_backoff_minutes, 1)
    task.notification_url = str(body.get("notificationUrl") or "").strip() or None
    task.next_run_at = calculate_next_run(task, _utc_now()) if task.enabled else None
    task.last_status = "idle" if task.enabled else "disabled"
    task.last_error = None
