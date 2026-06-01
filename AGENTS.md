# AGENTS.md

## Quick Start

```bash
# One-command start/stop via helper scripts (recommended)
./scripts/start-app.sh
./scripts/stop-app.sh
```

## Dev Commands

- **Backend (dev)**: `source .venv/bin/activate && FLASK_DEBUG=1 python backend/run.py`
- **Backend (prod)**: `source .venv/bin/activate && python backend/run.py` (uses gunicorn + gevent)
- **Frontend**: `npm --prefix frontend run dev`
- **OpenCode server**: `opencode serve --hostname 127.0.0.1 --port 4096 --cors http://localhost:5173`

## Production Server

Backend runs via **gunicorn** with **gevent** worker (1 worker, greenlet-based concurrency).
SSE long-polling uses lightweight greenlets instead of waitress threads to prevent thread pool exhaustion on client disconnect.

- Config: `gunicorn -k gevent -w 1 --bind 0.0.0.0:$BACKEND_PORT`
- Backend listens on port 38473 (configurable via `BACKEND_PORT`)

## Service Order (required)

1. OpenCode server first (needs available port)
2. Backend (gunicorn on localhost:38473)
3. Frontend (Vite on localhost:5173)

Backend `/api/health` checks OpenCode proxy - if OpenCode isn't running, health check fails.

## Env Setup

```bash
cp .env.example .env
```

## Key Paths

- Frontend proxied API: `/api` → `http://localhost:8080`
- SQLite DB: `backend/data/app.db`
- OpenCode runtime metadata: `.runtime/opencode.port`, `.runtime/opencode.url`

## Tech Stack

- Frontend: Vite + React 18 + TypeScript
- Backend: Flask + Flask-SQLAlchemy + SQLite (default)
- DB override: Set `DATABASE_URL` in `.env` for PostgreSQL

---

## Ralph Loop

Ralph is an autonomous PRD-driven agent loop. Use it through the **Tasks** panel inside the app:

1. Open the **Tasks** tab for any project.
2. The **Ralph Loop** sidebar card shows the current `prd.json` status.
3. Click **Init PRD** to scaffold a starter `prd.json` in the project root.
4. Edit `prd.json` to describe your user stories.
5. Click **Create Ralph Task** to pre-fill a goal-type scheduled task.
6. Save and enable the task — it runs OpenCode repeatedly until all stories have `passes: true`.

### Key Files

- `scripts/ralph/ralph.sh` — Standalone CLI loop (optional, for terminal use)
- `scripts/ralph/prompt.md` — Prompt template used by `ralph.sh`
- `prd.json.example` — Example PRD format
- `.opencode/skills/*` — Global OpenCode skills: `prd`, `ralph`, `dev-browser`, `compound-engineering`, `frontend-design`

### prd.json format

```json
{
  "project": "My App",
  "branchName": "ralph/feature-name",
  "description": "What this PRD covers",
  "userStories": [
    {
      "id": "US-001",
      "title": "Story title",
      "description": "As a user I want ...",
      "acceptanceCriteria": ["Criterion 1"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```
