# TTS Regression Checklist

Updated: 2026-03-28

## Backend Spot Checks

- [x] `GET /api/tts/config`
  Result: provider is `qwen3`, speed field is present for all providers.
- [x] `GET /api/tts/voices`
  Result: returns only custom Qwen3 voices: `塔塔 / 陆沨 / 湾湾 / 天空 / 素子`.
- [x] `GET /api/tts/cache/info`
  Result: returns cache usage plus `max_files` and `max_mb`.
- [x] `POST /api/tts/stream`
  Result: Qwen3 request succeeds and cache hit is significantly faster than first synthesis.

## Reader Manual Checks

- [ ] PDF reader
  Check voice selector, speed selector, play, pause, resume, stop.
- [ ] PDF reader
  Check English split-word repair, for example `black hole` should not be read as `b lack hole`.
- [ ] PDF reader
  Check current chunk highlight and auto-scroll in text mode.
- [ ] TXT reader
  Check reading starts from current visible page instead of chapter start.
- [ ] TXT reader
  Check current chunk highlight and auto-scroll.
- [ ] EPUB reader
  Check chapter-to-chapter continuous reading.
- [ ] All readers
  Check Qwen3 loading dots do not shift surrounding controls.
- [ ] All readers
  Check reader-selected voice and speed persist after refresh / reopen.

## Settings Manual Checks

- [ ] Settings dialog
  Check TTS section expands correctly.
- [ ] TTS config panel
  Check default voice and default speed are editable for the active provider.
- [ ] TTS config panel
  Check Qwen3 voice dropdown loads real local voices.
- [ ] TTS config panel
  Check `测试发音` succeeds with `http://127.0.0.1:18790/v1`.
- [ ] TTS config panel
  Check cache stats render and `清理缓存` works.
- [ ] TTS config panel
  Check `恢复默认 TTS 配置` resets fields to app defaults and can be saved.

## Current Known Limits

- PDF / EPUB / TXT UI flows were not fully automated in this pass; the items above still need manual clicking.
- Existing frontend lint issues outside the TTS path may still exist in reader files.
