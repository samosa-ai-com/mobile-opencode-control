# ruff: noqa: F405
import os

from flask import jsonify, request
from sqlalchemy import or_

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


@api_bp.get("/projects")
@auth_required
def list_projects():
    try:
        limit = min(max(int(request.args.get("limit", "100")), 1), 300)
        offset = max(int(request.args.get("offset", "0")), 0)
    except ValueError:
        return jsonify({"error": "Invalid pagination parameters"}), 400

    query = str(request.args.get("q", "")).strip()

    base_query = _query_projects_with_sessions(Project.query)
    if query:
        like_query = f"%{query}%"
        base_query = base_query.filter(
            or_(Project.name.ilike(like_query), Project.path.ilike(like_query))
        )

    base_query = base_query.order_by(Project.last_activity_at.desc())
    total = base_query.count()
    projects = base_query.offset(offset).limit(limit).all()
    active_project_id = _get_setting("active_project_id")
    next_offset = offset + len(projects)
    return jsonify(
        {
            "projects": [_project_to_dict(project) for project in projects],
            "activeProjectId": active_project_id,
            "limit": limit,
            "offset": offset,
            "total": total,
            "hasMore": next_offset < total,
        }
    )


@api_bp.post("/projects/sync")
@auth_required
def sync_projects_from_opencode():
    try:
        upstream_projects = opencode_client.list_projects()
    except Exception as exc:
        return _bad_gateway("Failed to sync projects", exc)

    imported = 0
    updated = 0
    skipped = 0

    for upstream_project in upstream_projects:
        worktree = upstream_project.get("worktree")
        if not isinstance(worktree, str) or not worktree:
            skipped += 1
            continue

        worktree = _normalize_project_path(worktree)

        if worktree == "/" or not os.path.isdir(worktree):
            skipped += 1
            continue

        raw_name = upstream_project.get("name")
        name = (
            raw_name.strip()
            if isinstance(raw_name, str) and raw_name.strip()
            else os.path.basename(worktree.rstrip("/")) or worktree
        )

        time_info = (
            upstream_project.get("time")
            if isinstance(upstream_project.get("time"), dict)
            else {}
        )
        updated_at = _datetime_from_epoch_ms(time_info.get("updated")) or _utc_now()
        created_at = _datetime_from_epoch_ms(time_info.get("created")) or updated_at

        project = Project.query.filter_by(path=worktree).first()
        if project is None:
            project = Project(
                name=name,
                path=worktree,
                last_session_id=None,
                created_at=created_at,
                updated_at=updated_at,
                last_activity_at=updated_at,
            )
            db.session.add(project)
            imported += 1
            continue

        changed = False
        if project.name != name:
            project.name = name
            changed = True
        project_last_activity = _ensure_utc(project.last_activity_at)
        if updated_at > project_last_activity:
            project.last_activity_at = updated_at
            changed = True

        if changed:
            updated += 1

    db.session.flush()

    for project in Project.query.order_by(Project.id.asc()).all():
        _clear_project_session_cache(project.id)
        sorted_sessions = _list_project_sessions(
            project, opencode_client, limit=500
        )
        latest_session_id = None
        if sorted_sessions:
            latest_session_id = (
                str(sorted_sessions[0].get("id") or "").strip() or None
            )

        if project.last_session_id != latest_session_id:
            project.last_session_id = latest_session_id
            updated += 1

    db.session.commit()

    projects = _query_projects_with_sessions(
        Project.query.order_by(Project.last_activity_at.desc())
    ).all()
    active_project_id = _resolve_visible_active_project_id(projects)
    return jsonify(
        {
            "imported": imported,
            "updated": updated,
            "skipped": skipped,
            "projects": [_project_to_dict(project) for project in projects],
            "activeProjectId": active_project_id,
        }
    )


@api_bp.post("/projects")
@auth_required
def create_project():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    path = (body.get("path") or "").strip()

    if not path:
        return jsonify({"error": "Project path is required"}), 400

    normalized_path = _normalize_project_path(path)
    if normalized_path == "/":
        return jsonify({"error": "Project path cannot be /"}), 400

    if not os.path.isdir(normalized_path):
        try:
            os.makedirs(normalized_path, exist_ok=True)
        except OSError as exc:
            return _internal_error("Unable to create project folder", exc)

    if not name:
        name = os.path.basename(normalized_path.rstrip("/")) or normalized_path

    existing = Project.query.filter_by(path=normalized_path).first()
    if existing is not None:
        return jsonify(
            {
                "error": "Project already exists",
                "project": _project_to_dict(existing),
            }
        ), 409

    project = Project(name=name, path=normalized_path, last_activity_at=_utc_now())
    db.session.add(project)
    db.session.commit()

    try:
        _ensure_project_session(project, opencode_client)
    except Exception as exc:
        db.session.delete(project)
        db.session.commit()
        return _bad_gateway("Failed to create initial session", exc)

    return jsonify({"project": _project_to_dict(project)}), 201


@api_bp.post("/projects/<int:project_id>/select")
@auth_required
def select_project(project_id: int):
    project = Project.query.get(project_id)
    if project is None:
        return jsonify({"error": "Project not found"}), 404

    _set_setting("active_project_id", str(project.id))
    project.last_activity_at = _utc_now()
    db.session.commit()
    return jsonify({"ok": True, "activeProjectId": str(project.id)})


@api_bp.get("/state")
@auth_required
def get_state():
    active_project_id = _get_setting("active_project_id")
    default_model = _get_setting("default_model")
    return jsonify(
        {
            "activeProjectId": active_project_id,
            "defaultProjectRoot": settings.default_project_root,
            "defaultModel": default_model,
        }
    )


@api_bp.put("/settings")
@auth_required
def update_app_settings():
    body = request.get_json(silent=True) or {}
    default_model = body.get("defaultModel")
    if isinstance(default_model, str) and default_model.strip():
        _set_setting("default_model", default_model.strip())
    else:
        _delete_setting("default_model")
    db.session.commit()
    return jsonify({"ok": True, "defaultModel": _get_setting("default_model")})
