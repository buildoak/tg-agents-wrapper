# tg-agents-wrapper

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Telegram bot that wraps [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) (Agent SDK) and [OpenAI Codex](https://platform.openai.com/docs/guides/codex) into a conversational interface with voice I/O, message batching, session management, and context monitoring.

Built with [Bun](https://bun.sh) and [grammY](https://grammy.dev).

## Features

- **Multi-engine** -- switch between Claude and Codex mid-conversation with `/engine`
- **Voice I/O** -- Whisper transcription + dual TTS pipeline (ElevenLabs cloud or Kokoro local)
- **Message batching** -- collects rapid-fire Telegram messages into a single prompt (configurable delay)
- **Context monitoring** -- track token usage, cache stats, and context window fill via `/context`
- **Wet proxy integration** -- routes Claude API calls through [wet](https://github.com/anthropics/wet) for context compression; automatic healthcheck every 30 s with silent fallback to direct Anthropic if wet is down; `/context` shows compression stats (items compressed, tokens saved)
- **Session resilience** -- stale session UUID recovery: adapter buffers the new session ID until the first successful API response, then commits it; dead sessions are auto-cleared so the next query starts fresh without manual `/start`
- **Session persistence** -- sessions survive bot restarts (JSON file)
- **Photo and document support** -- send images and files directly to the AI
- **Graceful shutdown** -- saves sessions and aborts running queries on SIGINT/SIGTERM

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- [Anthropic API key](https://console.anthropic.com/) (for Claude engine)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) installed (the Claude adapter spawns it as a subprocess)
- OpenAI API key (optional -- for Codex engine and Whisper voice transcription)

### Installation & Setup

```bash
# Clone the repository
git clone https://github.com/buildoak/tg-agents-wrapper.git
cd tg-agents-wrapper

# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env and fill in your API keys

# Start the bot
bun run start
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Start a new session (resets previous) |
| `/stop` | Stop the current session |
| `/interrupt` | Abort the running query, keep session |
| `/engine [claude\|codex]` | Show or switch AI engine |
| `/context` | Show token usage and context window stats |
| `/effort [level]` | Set reasoning effort (minimal/low/medium/high/xhigh/max) |
| `/mode` | Switch between text and voice modes |
| `/voice [id]` | Show or change the TTS voice ID |
| `/batch` | Toggle batch delay (15s quick / 2m long) |
| `/thinking` | Toggle visibility of model thinking/reasoning |
| `/status` | Show session info (engine, effort, mode, idle time) |

## Architecture

```
Telegram --> grammy Bot --> Handlers (text/voice/photo/document)
                                |
                                v
                          BufferManager (configurable batch delay)
                                |
                                v
                          processQuery() --> EngineAdapter.query()
                                |                   |
                                |         +---------+----------+
                                |         v                    v
                                |  ClaudeAdapter          CodexAdapter
                                |  (Agent SDK)            (Codex SDK)
                                |         |                    |
                                v         v                    v
                         NormalizedEvent stream (unified interface)
                                |
                        +-------+----------------+
                        v       v                v
                   text.delta  tool.started   usage --> context tracking
                   text.done   tool.completed
                   done
```

Key modules:

- `src/engine/interface.ts` -- EngineAdapter contract and NormalizedEvent types
- `src/engine/claude.ts` -- Claude Agent SDK wrapper
- `src/engine/codex.ts` -- Codex SDK wrapper (thread-based)
- `src/handlers/query.ts` -- event loop consuming NormalizedEvent stream
- `src/session/` -- session store, context monitor, lifecycle management
- `src/buffer/` -- message batching and media group collection
- `src/voice/` -- transcription (Whisper) and TTS (ElevenLabs + Kokoro)

## Voice I/O

The bot supports dual TTS pipelines for voice output:

- **ElevenLabs Cloud TTS** - High-quality cloud-based text-to-speech (requires API key)
- **Kokoro Local TTS** - Local text-to-speech for privacy-focused setups (no API key required)

Voice input is handled via OpenAI Whisper transcription.

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Required | Description |
|----------|----------|-------------|
| `TGBOT_API_KEY` | Yes | Telegram Bot API token |
| `TGBOT_ALLOWED_USERS` | Yes | Comma-separated Telegram user IDs |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `OPENAI_API_KEY` | No | OpenAI API key (Codex engine + Whisper) |
| `WORKING_DIR` | No | Working directory for AI engines (default: `./`) |
| `DEFAULT_ENGINE` | No | Default engine: `claude` or `codex` (default: `claude`) |
| `CLAUDE_MODEL` | No | Claude model to use (default: `claude-opus-4-6`) |
| `CODEX_MODEL` | No | Codex model to use (default: `gpt-5.4`) |
| `DEFAULT_REASONING_EFFORT` | No | Reasoning effort level: `minimal`/`low`/`medium`/`high`/`xhigh`/`max` (default: `high`) |
| `BOT_NAME` | No | Display name in bot messages (default: `Bot`) |
| `ELEVENLABS_API_KEY` | No | ElevenLabs API key for cloud TTS |
| `ELEVENLABS_PUBLIC_OWNER_ID` | No | ElevenLabs public owner ID for shared voices |
| `DEFAULT_ELEVENLABS_VOICE_ID` | No | ElevenLabs voice ID for TTS |
| `ELEVENLABS_VOICE_NAME` | No | ElevenLabs voice name for display |
| `DEFAULT_KOKORO_VOICE` | No | Kokoro voice ID (default: `af_heart`) |
| `TG_SESSION_DIR` | No | Session storage directory (default: `/tmp/tg-agents-wrapper`) |
| `TG_FILES_DIR` | No | File storage directory (default: `/tmp/tg-agents-wrapper-files`) |
| `WET_PORT` | No | Port for [wet](https://github.com/anthropics/wet) context compression proxy; enables `/context` compression stats and automatic healthcheck with fallback to direct API |

## Development

```bash
# Run in development mode with auto-reload
bun run dev

# Type check
bun run check
```

## License

MIT

## Author

Nick Oak (buildoak)
