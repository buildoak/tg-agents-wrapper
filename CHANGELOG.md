# Changelog

## 1.1.0 (2026-04-20)

- Default Claude model switched from `claude-opus-4-6[1m]` to `claude-sonnet-4-6[1m]`. Sonnet is sufficient for Telegram chat work and substantially cheaper; override via `CLAUDE_MODEL` env var if you want Opus.
- Bumped `@anthropic-ai/claude-agent-sdk` from `0.2.81` to `0.2.110`.
- Pass `thinking: { type: 'adaptive' }` explicitly to the Claude SDK (previously relied on implicit SDK default).
- Effort mapping is now model-aware: the `xhigh` and `max` labels map to SDK `'max'` only for Opus models (`effort: 'max'` is documented as Opus-only); Sonnet caps at `'high'`. The default case returns `'high'` for safety on both model families.
- Effort labels (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) are unchanged for session persistence and `/effort` command UX.

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