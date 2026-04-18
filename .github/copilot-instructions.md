# Copilot Instructions for Duodushu Desktop

**Duodushu (多读书)** is a local-first, portable desktop EPUB/PDF reader with AI-assisted English learning. It uses a 3-tier architecture:

- **Electron** (`electron/`) — desktop shell, manages Python backend lifecycle, IPC bridge
- **Next.js frontend** (`frontend/`) — React 19 static export, served from `app://` in production
- **FastAPI backend** (`backend/`) — Python REST API, SQLite + FTS5, AI/TTS integrations

## Commands

### Full stack
```bash
npm run dev          # Next.js :3000 + Electron (auto-starts backend)
npm run build        # Full production build: frontend → backend (PyInstaller) → electron → package
```

### Frontend (`frontend/`)
```bash
npm run dev          # Next.js dev server on :3000
npm run build        # Static export to frontend/out/
npm run lint         # ESLint
```

### Backend (`backend/`)
```bash
python -m uvicorn app.main:app --reload --port 8000   # Dev server
pytest                                                  # All tests
pytest tests/test_foo.py::test_bar -v                  # Single test
```

## Architecture

### Inter-process Communication
- **Electron ↔ Frontend**: `preload.ts` IPC bridge; frontend accesses `window.electronAPI.*`; no Node.js in renderer
- **Frontend ↔ Backend**: HTTP REST to dynamic `API_URL`, resolved at runtime via `window.electronAPI.getBackendUrl()` — never hardcode `localhost:8000`. All calls centralized in `frontend/src/lib/api.ts`
- **Electron manages Python**: spawns `backend/dist/backend` (prod) or `backend/.venv` (dev), polls `/health`, kills on quit

### Portable Mode (Electron `main.ts`)
Data path resolution order:
1. `PORTABLE_EXECUTABLE_DIR` env var → `exe_dir/data/`
2. `exe_dir/data/` exists → portable mode
3. Otherwise → `app.getPath('userData')`

### Backend Layering
```
Router (≤20 lines) → Service (business logic) → Model (SQLAlchemy ORM)
```
Routers live in `routers/`, services in `services/`. Never put business logic in routers.
Key files: `models/database.py` (DB session + `BASE_DIR`), `parsers/factory.py` (routes by file extension), `services/supplier_factory.py` (AI provider factory: Gemini / OpenAI / DeepSeek), `services/dict_service.py` (cache → MDX → AI → external API pipeline).

### Frontend State
- `frontend/src/contexts/SettingsContext` — user preferences, persisted to backend
- `frontend/src/contexts/GlobalDialogsContext` — modal/dialog coordination
- Complex state: **Zustand**; simple state: `useState`; avoid prop drilling

## Conventions

### Language
- **Comments and commit messages must be in Simplified Chinese (简体中文)**
- Code identifiers (variables, functions, classes) in English

### Backend
- Use `pathlib.Path` exclusively — never `os.path`
- Build paths from `models.database.BASE_DIR`, never hardcode absolute paths
- SQLAlchemy 2.0 async patterns; inject DB via `Depends(get_db)`; never call `db.close()` manually
- Long-running ops (book parsing, FTS indexing, AI calls) must use `BackgroundTasks`
- Pydantic model fields: `snake_case`

### Frontend
- All API calls use relative `/api/...` paths (Next.js rewrite) or the runtime `API_URL` from `api.ts` — never `http://localhost:8000`
- JSON sent to backend must use `snake_case` keys
- Use `lib/logger.ts` for all logging — **no `console.log`**
- Use Tailwind CSS classes — no inline styles (except PDF dynamic positioning)
- No React Hooks or UI logic inside `frontend/src/lib/`

### Git commits
```
<type>: <subject in Chinese>

<body>
```
Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

## Key Anti-Patterns

| Anti-pattern | Fix |
|---|---|
| Business logic in Router | Move to `services/` |
| `os.path` in backend | Use `pathlib.Path` |
| `console.log` in frontend | Use `lib/logger.ts` |
| Hardcoded `localhost:8000` | Use `api.ts` / relative `/api/` paths |
| camelCase in API JSON bodies | Convert to snake_case |
| Sync IO in `async def` | Use `aiofiles` / `run_in_threadpool` |
| `window.location` navigation | Use Next.js `useRouter` |

## Reference Docs
- `docs/TDD.md` — authoritative technical architecture
- `docs/API.md` — REST API reference
- `docs/CONVENTIONS.md` — full code standards
- `docs/DATA_STORAGE.md` — data paths & portable mode details
- `backend/app/AGENTS.md` — backend agent patterns
- `frontend/src/lib/AGENTS.md` — frontend API/agent patterns
