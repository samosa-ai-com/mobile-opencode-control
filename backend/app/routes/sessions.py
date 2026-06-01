# ruff: noqa: F405
import requests
from flask import jsonify, request

from ..auth import auth_required
from ..db import db
from ..models import Project
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


@api_bp.get("/projects/<int:project_id>/sessions")
@auth_required
def list_project_sessions(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        _clear_project_session_cache(project.id)
        sessions = _list_project_sessions(project, opencode_client, limit=500)
    except Exception as exc:
        return _bad_gateway("Failed to load sessions", exc)

    active_session_id = project.last_session_id
    matching_session_ids = {
        str(session.get("id") or "").strip()
        for session in sessions
        if session.get("id")
    }
    if active_session_id and active_session_id not in matching_session_ids:
        active_session_id = None
        if project.last_session_id is not None:
            project.last_session_id = None
            db.session.commit()
    return jsonify(
        {
            "activeSessionId": active_session_id,
            "sessions": [
                _session_to_dict(
                    session,
                    active_session_id=active_session_id,
                    ownership_source="directory",
                    effective_project_path=project.path,
                )
                for session in sessions
            ],
        }
    )


@api_bp.post("/projects/<int:project_id>/sessions")
@auth_required
def create_project_session(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        session = opencode_client.create_session(
            directory=_normalize_project_path(project.path), title=project.name
        )
        session_id = str(session.get("id") or "").strip()
        if not session_id:
            raise ValueError("Unable to create OpenCode session")
        project.last_session_id = session_id
        project.session_status = "idle"
        project.last_activity_at = _utc_now()
        _clear_project_session_cache(project.id)
        db.session.commit()
    except Exception as exc:
        return _bad_gateway("Failed to create session", exc)

    return jsonify(
        {
            "ok": True,
            "activeSessionId": session_id,
            "session": _session_to_dict(
                session,
                active_session_id=session_id,
                ownership_source="directory",
                effective_project_path=project.path,
            ),
        }
    )


@api_bp.put("/projects/<int:project_id>/session")
@auth_required
def update_project_session(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    requested_session_id = str(body.get("sessionId") or "").strip()
    if not requested_session_id:
        return jsonify({"error": "sessionId is required"}), 400

    try:
        session = opencode_client.get_session(requested_session_id)
        if not _session_matches_project(project, session):
            return jsonify({"error": "Selected session does not belong to this project"}), 400
        project.last_session_id = requested_session_id
        project.last_activity_at = _utc_now()
        _clear_project_session_cache(project.id)
        db.session.commit()
        session_id = requested_session_id
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return jsonify({"error": "Session not found"}), 404
        return _bad_gateway("Failed to switch session", exc)
    except Exception as exc:
        return _bad_gateway("Failed to switch session", exc)

    return jsonify(
        {
            "ok": True,
            "activeSessionId": session_id,
            "session": _session_to_dict(
                session,
                active_session_id=session_id,
                ownership_source="directory",
                effective_project_path=project.path,
            ),
        }
    )


@api_bp.delete("/projects/<int:project_id>/sessions/<session_id>")
@auth_required
def delete_project_session(project_id: int, session_id: str):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    requested_session_id = str(session_id or "").strip()
    if not requested_session_id:
        return jsonify({"error": "sessionId is required"}), 400

    try:
        session = opencode_client.get_session(requested_session_id)
        if not _session_matches_project(project, session):
            return jsonify(
                {"error": "Selected session does not belong to this project"}
            ), 400

        opencode_client.delete_session(requested_session_id)
        _clear_project_session_cache(project.id)

        remaining_sessions = _list_project_sessions(
            project, opencode_client, limit=500
        )
        deleted_project_id: str | None = None
        next_active_project_id: str | None = None
        next_active_session_id = project.last_session_id
        remaining_ids = {
            str(item.get("id") or "").strip()
            for item in remaining_sessions
            if item.get("id")
        }

        if (
            requested_session_id == project.last_session_id
            or project.last_session_id not in remaining_ids
        ):
            next_active_session_id = (
                str(remaining_sessions[0].get("id") or "").strip()
                if remaining_sessions
                else None
            )
            project.last_session_id = next_active_session_id

        if not remaining_sessions:
            deleted_project_id = str(project.id)
            active_project_id = _get_setting("active_project_id")
            fallback_project = (
                _query_projects_with_sessions(
                    Project.query.filter(Project.id != project.id)
                )
                .order_by(Project.last_activity_at.desc())
                .first()
            )
            if active_project_id == deleted_project_id:
                if fallback_project is None:
                    _delete_setting("active_project_id")
                else:
                    next_active_project_id = str(fallback_project.id)
                    _set_setting("active_project_id", next_active_project_id)

            _clear_project_session_cache(project.id)
            _delete_setting(_project_setting_key(project.id, "model"))
            _delete_setting(_project_setting_key(project.id, "agent"))
            db.session.delete(project)
        else:
            project.last_activity_at = _utc_now()

        db.session.commit()
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else 502
        if status_code == 404:
            return jsonify({"error": "Session not found"}), 404
        return _bad_gateway("Failed to delete session", exc)
    except Exception as exc:
        return _bad_gateway("Failed to delete session", exc)

    return jsonify(
        {
            "ok": True,
            "deletedSessionId": requested_session_id,
            "activeSessionId": None
            if deleted_project_id
            else project.last_session_id,
            "projectDeleted": bool(deleted_project_id),
            "deletedProjectId": deleted_project_id,
            "activeProjectId": next_active_project_id,
            "sessions": [
                _session_to_dict(
                    item,
                    active_session_id=None
                    if deleted_project_id
                    else project.last_session_id,
                    ownership_source="directory",
                    effective_project_path=project.path,
                )
                for item in remaining_sessions
            ],
        }
    )


@api_bp.post("/projects/<int:project_id>/session/ensure")
@auth_required
def ensure_project_session(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        session_id = _ensure_project_session(project, opencode_client)
    except Exception as exc:
        return _bad_gateway("Failed to ensure session", exc)

    return jsonify({"sessionId": session_id})


@api_bp.post("/projects/<int:project_id>/abort")
@auth_required
def abort_project_session(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    try:
        body = request.get_json(silent=True) or {}
        requested_session_id = str(body.get("sessionId") or "").strip() or None
        if requested_session_id:
            session_id = _resolve_project_session(
                project,
                opencode_client,
                session_id=requested_session_id,
                create_if_missing=False,
            )
        else:
            session_id = _ensure_project_session(project, opencode_client)
        ok = opencode_client.abort_session(session_id, directory=project.path)
        project.session_status = "idle"
        project.last_activity_at = _utc_now()
        db.session.commit()
        return jsonify({"ok": ok, "sessionId": session_id})
    except Exception as exc:
        project.session_status = "error"
        db.session.commit()
        return _bad_gateway("Failed to abort session", exc)


@api_bp.post("/projects/<int:project_id>/sessions/<session_id>/compact")
@auth_required
def compact_project_session(project_id: int, session_id: str):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    requested_session_id = str(session_id or "").strip()
    if not requested_session_id:
        return jsonify({"error": "sessionId is required"}), 400

    try:
        resolved_session_id = _resolve_project_session(
            project,
            opencode_client,
            session_id=requested_session_id,
            create_if_missing=False,
        )
        ok = opencode_client.compact_session(resolved_session_id, directory=project.path)
        project.last_activity_at = _utc_now()
        db.session.commit()
        return jsonify({"ok": ok, "sessionId": resolved_session_id})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return _bad_gateway("Failed to compact session", exc)


@api_bp.post("/projects/<int:project_id>/sessions/<session_id>/summarize")
@auth_required
def summarize_project_session(project_id: int, session_id: str):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    requested_session_id = str(session_id or "").strip()
    if not requested_session_id:
        return jsonify({"error": "sessionId is required"}), 400

    body = request.get_json(silent=True) or {}

    try:
        resolved_session_id = _resolve_project_session(
            project,
            opencode_client,
            session_id=requested_session_id,
            create_if_missing=False,
        )
        provider_data = opencode_client.list_config_providers()
        default_map = provider_data.get("default") if isinstance(provider_data.get("default"), dict) else {}
        provider_id = str(body.get("providerID") or "").strip()
        model_id = str(body.get("modelID") or "").strip()
        if not provider_id or not model_id:
            default_model = default_map.get(list(default_map.keys())[0]) if default_map else None
            if default_model and isinstance(default_model, str):
                provider_id, _, model_id = default_model.partition("/")
            else:
                return jsonify({"error": "providerID and modelID are required"}), 400
        ok = opencode_client.summarize_session(
            resolved_session_id,
            provider_id=provider_id,
            model_id=model_id,
            directory=project.path,
            auto=body.get("auto", False),
        )
        project.last_activity_at = _utc_now()
        db.session.commit()
        return jsonify({"ok": ok, "sessionId": resolved_session_id})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return _bad_gateway("Failed to summarize session", exc)
