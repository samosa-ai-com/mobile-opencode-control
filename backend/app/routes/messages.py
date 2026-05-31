# ruff: noqa: F405
import json

import requests
from flask import Response, jsonify, request, stream_with_context

from ..auth import auth_required
from ..db import db
from ..models import Project, TimelineEvent
from . import api_bp
from .helpers import *  # noqa: F401,F403




app = None
settings = None
opencode_client = None
scheduler = None
voice_runtime = None


def configure(app_instance, settings_instance, opencode_client_instance, scheduler_instance, voice_runtime_instance):
    global app, settings, opencode_client, scheduler, voice_runtime
    app = app_instance
    settings = settings_instance
    opencode_client = opencode_client_instance
    scheduler = scheduler_instance
    voice_runtime = voice_runtime_instance


@api_bp.get("/projects/<int:project_id>/messages")
@auth_required
def get_project_messages(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        session_id_param = request.args.get("session_id", "").strip()
        if session_id_param:
            session = opencode_client.get_session(session_id_param)
            if _session_matches_project(project, session):
                session_id = session_id_param
            else:
                return jsonify({"error": "Selected session does not belong to this project"}), 400
        else:
            session_id = _ensure_project_session(project, opencode_client)
        limit = int(request.args.get("limit", "100"))
        limit = min(max(limit, 1), 200)
        messages = opencode_client.list_messages(
            session_id=session_id, limit=limit, directory=project.path
        )
        timeline_events = (
            TimelineEvent.query.filter_by(project_id=project_id)
            .order_by(TimelineEvent.created_at.asc())
            .limit(500)
            .all()
        )
    except Exception as exc:
        return _bad_gateway("Failed to load messages", exc)

    return jsonify(
        {
            "sessionId": session_id,
            "messages": [_message_to_dict(message) for message in messages],
            "timelineEvents": [
                _timeline_event_to_dict(event) for event in timeline_events
            ],
        }
    )


@api_bp.post("/projects/<int:project_id>/messages")
@auth_required
def send_project_message(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    text = str(body.get("text") or "").strip()
    requested_session_id = str(body.get("sessionId") or "").strip() or None
    if not text:
        return jsonify({"error": "Message text is required"}), 400

    try:
        if requested_session_id:
            session_id = _resolve_project_session(
                project,
                opencode_client,
                session_id=requested_session_id,
                create_if_missing=False,
            )
        else:
            session_id = _ensure_project_session(project, opencode_client)
        runtime_selection = _get_project_runtime_selection(project.id)
        project.session_status = "running"
        db.session.commit()

        opencode_client.send_message_async(
            session_id=session_id,
            directory=project.path,
            text=text,
            model=runtime_selection["model"],
            agent=runtime_selection["agent"],
        )

        project.last_message_preview = text[:180]
        project.last_activity_at = _utc_now()
        db.session.commit()
    except Exception as exc:
        project.session_status = "error"
        db.session.commit()
        return _bad_gateway("Failed to send message", exc)

    return jsonify(
        {
            "sessionId": session_id,
            "ok": True,
        }
    )


@api_bp.post("/projects/<int:project_id>/commands")
@auth_required
def run_project_command(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    command = str(body.get("command") or "").strip().lstrip("/")
    requested_session_id = str(body.get("sessionId") or "").strip() or None
    arguments = body.get("arguments") or []

    if not command:
        return jsonify({"error": "Command is required"}), 400
    if not isinstance(arguments, list):
        return jsonify({"error": "Command arguments must be a list"}), 400

    safe_args = [str(arg) for arg in arguments]

    try:
        if requested_session_id:
            session_id = _resolve_project_session(
                project,
                opencode_client,
                session_id=requested_session_id,
                create_if_missing=False,
            )
        else:
            session_id = _ensure_project_session(project, opencode_client)

        if command in LOCAL_SESSION_COMMANDS:
            if command in ("compact", "summarize"):
                provider_data = opencode_client.list_config_providers()
                default_map = provider_data.get("default") if isinstance(provider_data.get("default"), dict) else {}
                default_model = default_map.get(list(default_map.keys())[0]) if default_map else None
                if default_model and isinstance(default_model, str):
                    provider_id, _, model_id = default_model.partition("/")
                    opencode_client.summarize_session(
                        session_id,
                        provider_id=provider_id,
                        model_id=model_id,
                        directory=project.path,
                    )
                else:
                    opencode_client.compact_session(session_id, directory=project.path)
                normalized = _local_message(
                    "Session compaction started. The conversation will be summarized."
                )
                project.last_message_preview = normalized.get("text") or "/compact"
            else:
                opencode_client.abort_session(session_id, directory=project.path)
                normalized = _local_message(
                    "Stopped current agent execution for this session."
                )
                project.last_message_preview = normalized.get("text") or "/stop"
                project.session_status = "idle"
            project.last_activity_at = _utc_now()
            db.session.commit()
            return jsonify(
                {"sessionId": session_id, "message": normalized, "localOnly": True}
            )

        available_commands = {
            str(item.get("name")): item
            for item in opencode_client.list_commands()
            if item.get("name")
        }
        if command not in available_commands:
            names = sorted(available_commands.keys())
            preview = ", ".join(names[:8])
            more = "" if len(names) <= 8 else ", ..."
            return (
                jsonify(
                    {
                        "error": (
                            f"Command '/{command}' is not available on this OpenCode server. "
                            f"Available commands: {preview}{more}"
                        ),
                        "availableCommands": names,
                    }
                ),
                400,
            )

        response_message = opencode_client.run_command(
            session_id=session_id,
            command=command,
            arguments=safe_args,
            directory=project.path,
        )

        normalized = _message_to_dict(response_message)
        project.last_message_preview = normalized.get("text") or f"/{command}"
        project.last_activity_at = _utc_now()
        project.session_status = "idle"
        db.session.commit()
    except Exception as exc:
        project.session_status = "error"
        db.session.commit()
        return _bad_gateway("Failed to run command", exc)

    return jsonify({"sessionId": session_id, "message": normalized})


@api_bp.get("/projects/<int:project_id>/diff")
@auth_required
def get_project_diff(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        session_id = _ensure_project_session(project, opencode_client)
        diff = opencode_client.get_diff(
            session_id=session_id, directory=project.path
        )
        return jsonify({"sessionId": session_id, "diff": diff})
    except Exception as exc:
        return _bad_gateway("Failed to load diff", exc)


@api_bp.get("/projects/<int:project_id>/approvals")
@auth_required
def get_project_approvals(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    session_id = project.last_session_id
    if session_id:
        try:
            session_id = _resolve_project_session(
                project,
                opencode_client,
                session_id=session_id,
                create_if_missing=False,
            )
        except Exception:
            session_id = project.last_session_id

    return jsonify(
        {"approvals": _get_project_pending_approvals(project.id, session_id)}
    )


@api_bp.get("/projects/<int:project_id>/questions")
@auth_required
def get_project_questions(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    session_id = project.last_session_id
    if session_id:
        try:
            session_id = _resolve_project_session(
                project,
                opencode_client,
                session_id=session_id,
                create_if_missing=False,
            )
        except Exception:
            session_id = project.last_session_id

    try:
        upstream_questions = opencode_client.list_questions(directory=project.path)
        if upstream_questions:
            _set_project_pending_questions(project.id, upstream_questions)
        else:
            _clear_project_pending_questions(project.id)
        db.session.commit()
    except Exception as exc:
        app.logger.warning("Failed to list upstream questions for project %s: %s", project.id, exc)

    return jsonify({"questions": _get_project_pending_questions(project.id, session_id)})


@api_bp.get("/projects/<int:project_id>/stream")
@auth_required
def stream_project_events(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        session_id = _ensure_project_session(project, opencode_client)
    except Exception as exc:
        return _bad_gateway("Failed to ensure session", exc)

    db.session.remove()

    def _stream():
        ready_payload = json.dumps(
            {"sessionId": session_id, "event": ["event: stream.ready"]}
        )
        yield f"data: {ready_payload}\n\n"
        try:
            with requests.get(
                f"{opencode_client.base_url}/global/event",
                params={"directory": project.path},
                headers=opencode_client.event_headers,
                stream=True,
                timeout=600,
            ) as upstream:
                upstream.raise_for_status()
                event_lines: list[str] = []

                for line in upstream.iter_lines(decode_unicode=True):
                    if line is None:
                        continue

                    normalized_line = line.rstrip("\n")
                    if not normalized_line:
                        if event_lines and _event_matches_session(
                            event_lines, session_id
                        ):
                            _update_pending_approvals_from_event(
                                project.id, session_id, event_lines
                            )
                            _update_pending_questions_from_event(
                                project.id, session_id, event_lines
                            )
                            data = json.dumps(
                                {"sessionId": session_id, "event": event_lines}
                            )
                            yield f"data: {data}\n\n"
                        event_lines = []
                        continue

                    if normalized_line.startswith(":"):
                        # Forward SSE comment heartbeats to keep connection alive
                        yield f"{normalized_line}\n"
                        continue
                    event_lines.append(normalized_line)
        except Exception:
            app.logger.exception(
                "Failed to stream project events for project %s", project.id
            )
            error_payload = json.dumps(
                {"sessionId": session_id, "error": "Stream connection failed"}
            )
            yield f"event: error\ndata: {error_payload}\n\n"

    return Response(
        stream_with_context(_stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@api_bp.get("/projects/events")
@auth_required
def stream_global_project_events():
    db.session.remove()

    def _stream():
        try:
            with requests.get(
                f"{opencode_client.base_url}/global/sync-event",
                headers=opencode_client.event_headers,
                stream=True,
                timeout=600,
            ) as upstream:
                upstream.raise_for_status()
                event_lines: list[str] = []

                for line in upstream.iter_lines(decode_unicode=True):
                    if line is None:
                        continue

                    normalized_line = line.rstrip("\n")
                    if not normalized_line:
                        if event_lines:
                            data = json.dumps({"event": event_lines})
                            yield f"data: {data}\n\n"
                        event_lines = []
                        continue

                    if normalized_line.startswith(":"):
                        continue
                    event_lines.append(normalized_line)
        except Exception:
            app.logger.exception("Failed to stream global project events")
            error_payload = json.dumps({"error": "Stream connection failed"})
            yield f"event: error\ndata: {error_payload}\n\n"

    return Response(
        stream_with_context(_stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@api_bp.post("/projects/<int:project_id>/permissions/<permission_id>")
@auth_required
def respond_project_permission(project_id: int, permission_id: str):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    response_value = str(body.get("response") or "").strip().lower()
    remember = bool(body.get("remember", False))

    mapping = {
        "approve": "allow",
        "allow": "allow",
        "yes": "allow",
        "deny": "deny",
        "reject": "deny",
        "no": "deny",
    }
    normalized = mapping.get(response_value)
    if normalized is None:
        return jsonify({"error": "Response must be approve or deny"}), 400

    try:
        session_id = _ensure_project_session(project, opencode_client)
        ok = opencode_client.respond_permission(
            session_id=session_id,
            directory=project.path,
            permission_id=permission_id,
            response_value=normalized,
            remember=remember,
        )
        approvals = _get_project_pending_approvals(project.id)
        next_approvals = [
            item
            for item in approvals
            if not (
                str(item.get("permissionId") or "") == permission_id
                and str(item.get("sessionId") or "") == session_id
            )
        ]
        if next_approvals:
            _set_project_pending_approvals(project.id, next_approvals)
        else:
            _clear_project_pending_approvals(project.id)
        project.last_activity_at = _utc_now()
        project.session_status = "idle"
        db.session.commit()
        return jsonify(
            {
                "ok": ok,
                "sessionId": session_id,
                "permissionId": permission_id,
                "response": normalized,
            }
        )
    except Exception as exc:
        project.session_status = "error"
        db.session.commit()
        return _bad_gateway("Failed to respond to permission", exc)


@api_bp.post("/projects/<int:project_id>/questions/<request_id>/reply")
@auth_required
def reply_project_question(project_id: int, request_id: str):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    answers = body.get("answers")
    if not isinstance(answers, list):
        return jsonify({"error": "answers must be an array"}), 400

    normalized_answers: list[list[str]] = []
    for answer in answers:
        if not isinstance(answer, list):
            return jsonify({"error": "answers must be an array of string arrays"}), 400
        normalized_answers.append([str(item) for item in answer])

    try:
        ok = opencode_client.reply_question(
            request_id=request_id,
            answers=normalized_answers,
            directory=project.path,
        )
        questions = _get_project_pending_questions(project.id)
        next_questions = [
            item for item in questions if str(item.get("id") or "").strip() != request_id
        ]
        if next_questions:
            _set_project_pending_questions(project.id, next_questions)
        else:
            _clear_project_pending_questions(project.id)
        project.last_activity_at = _utc_now()
        db.session.commit()
        return jsonify({"ok": ok, "requestId": request_id})
    except Exception as exc:
        return _bad_gateway("Failed to respond to question", exc)


@api_bp.post("/projects/<int:project_id>/questions/<request_id>/reject")
@auth_required
def reject_project_question(project_id: int, request_id: str):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        ok = opencode_client.reject_question(
            request_id=request_id,
            directory=project.path,
        )
        questions = _get_project_pending_questions(project.id)
        next_questions = [
            item for item in questions if str(item.get("id") or "").strip() != request_id
        ]
        if next_questions:
            _set_project_pending_questions(project.id, next_questions)
        else:
            _clear_project_pending_questions(project.id)
        project.last_activity_at = _utc_now()
        db.session.commit()
        return jsonify({"ok": ok, "requestId": request_id})
    except Exception as exc:
        return _bad_gateway("Failed to reject question", exc)
