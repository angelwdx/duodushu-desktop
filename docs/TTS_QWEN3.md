# Qwen3 TTS Setup

Updated: 2026-03-28

## Recommended Local Service

- Stable API URL: `http://127.0.0.1:18790/v1`
- Model: `tts-1`
- Recommended voices: `塔塔 / 陆沨 / 湾湾 / 天空 / 素子`

This project uses the local stable Qwen3 service rather than the older `18788` Gradio-style endpoint for reading playback.

## Local Service Files

- Stable API: `/Users/tachikoma/.openclaw/skills/qwen3-tts/stable_api.py`
- Start script: `/Users/tachikoma/.openclaw/skills/qwen3-tts/start_stable_api.sh`
- LaunchAgent: `/Users/tachikoma/Library/LaunchAgents/com.tachikoma.qwen3tts.stable.plist`

## Backend App Config

The desktop app stores runtime config in:

- `/Users/tachikoma/Library/Application Support/duodushu-desktop/app_config.json`

The backend must be started with:

```bash
./.venv/bin/python backend/run_backend.py --host 127.0.0.1 --port 8000 --data-dir '/Users/tachikoma/Library/Application Support/duodushu-desktop'
```

Do not switch back to `backend/data` for this local environment, or the bookshelf / config will point at the wrong data source.

## Current TTS Features

- Reader voice selection for Qwen3
- Reader speed selection
- Reader-selected voice and speed persisted into TTS config
- Qwen3 voice list filtered to custom local voices only
- Qwen3 chunk prefetch queue to reduce pauses
- Audio cache for repeated playback
- Automatic cache pruning by entry count and total size
- Shared text preprocessing for broken English word repair

## Cache

- Cache directory: `/Users/tachikoma/Library/Application Support/duodushu-desktop/uploads/audio_cache`
- Current backend cache policy:
  - max files: `200`
  - max size: `512 MB`

You can inspect cache stats through:

```bash
curl http://127.0.0.1:8000/api/tts/cache/info
```

## Troubleshooting

- If `测试发音` fails, first check:
  - `http://127.0.0.1:18790/health`
  - `http://127.0.0.1:8000/api/tts/config`
  - `http://127.0.0.1:8000/api/tts/voices`
- If the bookshelf looks wrong after backend restart, confirm the backend was started with the real Electron `userData` directory shown above.
- If a PDF reads split English words strangely, verify the reader is using the latest frontend bundle with shared TTS text preprocessing.
