# ruff: noqa: F405
from flask import jsonify

from ..auth import auth_required
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


@api_bp.get("/opencode/health")
@auth_required
def opencode_health():
    try:
        data = opencode_client.health()
        return jsonify({"healthy": True, "upstream": data})
    except Exception as exc:
        return (
            jsonify(
                {
                    "healthy": False,
                    "error": str(exc),
                    "upstreamBaseUrl": settings.opencode_base_url,
                }
            ),
            502,
        )


@api_bp.get("/opencode/commands")
@auth_required
def opencode_commands():
    try:
        commands = opencode_client.list_commands()
        normalized = []
        for item in commands:
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            if name in LOCAL_SESSION_COMMANDS:
                continue
            normalized.append(
                {
                    "name": name,
                    "description": str(item.get("description") or "").strip(),
                }
            )
        return jsonify({"commands": normalized})
    except Exception as exc:
        return jsonify({"error": f"Failed to load commands: {exc}"}), 502


@api_bp.get("/opencode/sse-info")
@auth_required
def opencode_sse_info():
    try:
        data = opencode_client.health()
        base_url = settings.opencode_base_url
        auth_header = opencode_client.auth_header
        return jsonify({
            "url": base_url,
            "auth": auth_header,
            "healthy": True,
        })
    except Exception as exc:
        return jsonify({"healthy": False, "error": str(exc)}), 502
