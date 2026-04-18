# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Duodushu (多读书)** is a local-first, portable desktop EPUB/PDF reader with AI-assisted English learning features. It uses a 3-tier architecture:

- **Electron** (`electron/`) — desktop shell, manages Python backend lifecycle, IPC bridge
- **Next.js frontend** (`frontend/`) — React 19 static export, served from `app://` in production
- **FastAPI backend** (`backend/`) — Python REST API, SQLite + FTS5, AI/TTS integrations

## Development Commands

### Full Stack
```bash
./dev.sh             # 启动前后端服务 (使用开发版独立数据)
./dev.sh --sync      # 启动前后端服务 (同步 Mac 正式版书籍数据)
npm run dev          # 启动全面开发环境 (Next.js + Electron + Backend)
npm run build        # Full production build: frontend → backend (PyInstaller) → electron → package
```

> **Note for this machine**: Node.js is located in `/opt/homebrew/bin`, which is automatically handled by `dev.sh`.


### Frontend (`frontend/`)
```bash
cd frontend
npm run dev          # Next.js dev server on :3000
npm run build        # Static export to frontend/out/
npm run lint         # ESLint
```

### Backend (`backend/`)
```bash
cd backend
python -m venv .venv && pip install -r requirements.txt   # First time setup
python -m uvicorn app.main:app --reload --port 8000       # Dev server
pytest               # Run all tests
pytest tests/test_foo.py::test_bar -v                     # Run a single test
```

## Architecture

### Electron ↔ Frontend ↔ Backend Communication
- **Electron ↔ Frontend**: via `preload.ts` IPC bridge; frontend accesses `window.electronAPI.*`; no Node.js in renderer
- **Frontend ↔ Backend**: HTTP REST to `localhost:8000` (all in `frontend/src/lib/api.ts`)
- **Electron manages Python**: spawns `backend/dist/backend` (prod) or `backend/.venv` (dev), polls `/health`, kills on quit

### Portable Mode Detection (Electron `main.ts`)
Data path resolution order:
1. `PORTABLE_EXECUTABLE_DIR` env var → `exe_dir/data/` (Windows Portable.exe)
2. `exe_dir/data/` exists → use it (portable detection)
3. Otherwise → `app.getPath('userData')` (AppData / `~/Library`)

### Backend 3-Layer Architecture
```
Router (< 20 lines, in routers/) → Service (business logic, in services/) → Model (SQLAlchemy ORM, in models/)
```
Key routers: `books`, `vocabulary`, `ai`, `tts`, `dictionary`, `dicts`, `rag`, `bookmarks`, `config`

### Database
SQLite at `${dataPath}/app.db` with FTS5 virtual table `pages_fts` for full-text search. Migrations via Alembic + raw SQL on startup.

### AI Provider Pattern
`backend/app/services/supplier_factory.py` — factory for Gemini / OpenAI / DeepSeek. Providers configured via settings, selected at runtime.

### Frontend State
Global state via React contexts in `frontend/src/contexts/`:
- `SettingsContext` — user preferences, persisted to backend
- `GlobalDialogsContext` — modal/dialog coordination

Large components: `EPUBReader.tsx` (~98KB, epubjs), `PDFReader.tsx` (~67KB, react-pdf), `DictionarySidebar.tsx`, `AITeacherSidebar.tsx`

## Code Conventions

From `docs/CONVENTIONS.md`:
- **Comments in Chinese**, code identifiers in English
- **Backend**: always use `pathlib.Path`, never `os.path`
- **Routes**: keep < 20 lines; delegate all logic to services
- **Database**: SQLAlchemy 2.0 async patterns; never call `db.close()` manually
- **Sensitive data**: use keyring, never `.env` in git

## Key Docs

- `docs/TDD.md` — full technical architecture (authoritative reference)
- `docs/API.md` — REST API reference
- `docs/DATA_STORAGE.md` — data paths & portable mode details
- `docs/CONVENTIONS.md` — code standards
- `frontend/src/lib/AGENTS.md` — frontend API/agent patterns
- `backend/app/AGENTS.md` — backend agent patterns
