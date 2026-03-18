# Changelog

## 1.0.1 (2026-03-18)

- Fix `/context` command showing inflated token counts (876k vs actual 132k). The Claude SDK `result` event reports aggregate billing tokens across all subagent API calls, not the current context window fill. Now prefers wet proxy's `latest_total_input_tokens` as the authoritative source when available, with SDK fallback labeled accordingly.

## 1.0.0 (2026-03-16)

Initial public release.

- Multi-engine support (Claude Code via Agent SDK, OpenAI Codex)
- Telegram bot with voice I/O (Whisper + ElevenLabs + Kokoro)
- Message batching for rapid-fire Telegram messages
- Context monitoring with optional wet proxy integration
- Session persistence across bot restarts
- Photo and document support
- Configurable reasoning effort levels
- Graceful shutdown with session saving