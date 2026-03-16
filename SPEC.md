# tg-bot-ts-v2 — Technical Spec

Telegram bot wrapping Claude Agent SDK and Codex SDK into a conversational interface with voice I/O, message batching, streaming tool status, context monitoring, and session persistence. Runs on Bun, uses grammY for Telegram.

Four workstreams: wet integration, gaal integration, compaction/eywa cleanup, open source extraction.

## Architecture

```
Telegram -> grammY Bot -> Handlers (text/voice/photo/document)
                              |
                              v
                        BufferManager (configurable batch delay)
                              |
                              v
                        processQuery() -> EngineAdapter.query()
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
                 text.delta  tool.started   usage -> ContextMonitor
                 text.done   tool.completed
                 done        context.warning
```

Key modules:
- `engine/interface.ts` -- EngineAdapter contract, NormalizedEvent union, QueryConfig
- `engine/claude.ts` -- Claude Agent SDK wrapper, PreCompact hook (to be removed)
- `engine/codex.ts` -- Codex SDK wrapper (Thread-based)
- `handlers/query.ts` -- event loop consuming NormalizedEvent stream, TG message dispatch
- `session/context-monitor.ts` -- threshold alerts (to be stripped), context warning handler
- `session/lifecycle.ts` -- extraction via eywa (to be replaced with simple reset)
- `session/store.ts` -- in-memory Map<userId, Session> with JSON persistence
- `buffer/message-buffer.ts` -- batches rapid-fire TG messages into single prompts
- `bot.ts` -- command registration (/start, /stop, /engine, /context, /effort, etc.)

## WS-1: Wet Integration

**Goal:** Replace bot's internal context estimation with wet's authoritative token counts.

**Current state.** Context tracking is end-of-turn only: the `usage` event carries `inputTokens + cachedInputTokens + cacheCreationInputTokens`. Stored in `session.cumulativeInputTokens`. The only mid-turn signal is PreCompact, which fires when context is already at the wall. Between turns, the bot is blind to context growth from large tool results (PDF reads can balloon by ~500K tokens in a single Read call via base64 JPEG).

**Target state.** Bot queries `wet status --json` between turns for ground-truth context metrics. This replaces the bot's own percentage calculation for Claude sessions.

**Integration approach: CLI shell-out.**
- Wet is a Go binary. Bot is TypeScript/Bun. Shell out to `wet` CLI.
- The bot does NOT launch `wet claude` -- that is done externally (user starts the bot under wet by setting `ANTHROPIC_BASE_URL`). Bot only queries wet's control plane.
- `wet status --json` returns: `api_input_tokens`, `context_window`, `items_compressed`, `items_total`, `tokens_saved`, `latest_total_input_tokens`, `paused`, `mode`.
- `wet inspect --json` returns per-item breakdown: `tool_use_id`, `tool_name`, `turn`, `stale`, `token_count`.
- Port discovery: `WET_PORT` env var. If unset, wet integration disabled gracefully.

**SDK integration path.** Claude Agent SDK spawns `cli.js` as a child process. The subprocess reads `ANTHROPIC_BASE_URL` from its env. The bot's `cleanEnv` in `claude.ts` (line ~150) already spreads `process.env` to the subprocess, so setting `ANTHROPIC_BASE_URL` at the bot process level flows through automatically. For explicit control, set it in `cleanEnv` when `WET_PORT` is configured.

**ToolSearch caveat.** Setting `ANTHROPIC_BASE_URL` to a non-first-party host (wet's localhost proxy) disables Claude Code's deferred tool loading (ToolSearch). All tool schemas load eagerly (~5-10K extra tokens). Do NOT override with `ENABLE_TOOL_SEARCH=true` -- the flag sends a beta header (`advanced-tool-use-2025-11-20`) on every API call and fires telemetry (`tengu_mcp_cli_status` with `source: "external_tool_search_env_var"`) specifically tracking external overrides. The 0.5-1% context overhead from eager loading is acceptable; the non-standard usage signal is not.

**Compression is skill-only.** The bot never triggers `wet compress`. The user talks to Claude, Claude uses the wet skill. Bot is read-only observer.

**Scope:** Claude engine only. Wet proxies Anthropic API; Codex goes direct to OpenAI.

**Changes to /context command:**
- When `WET_PORT` set and engine is Claude: show wet token counts (items tracked, compressed, tokens saved)
- SDK-based tracking as fallback when wet not running
- No cost display -- token counts only, wet is source of truth

**Tasks:**
1. Add `src/integrations/wet.ts` -- async functions: `isWetAvailable()`, `getWetStatus()`, `getWetInspect()`. Shell out with `--json`, parse, return typed results. Timeout 2s.
2. Modify `context-monitor.ts` -- add `getContextFromWet()` as primary source when available. SDK numbers as fallback.
3. Modify `/context` command in `bot.ts` -- show wet-augmented data when available. Drop cost display.
4. Add `WET_PORT` to config and `.env.example`.

## WS-2: Gaal Integration

**Goal:** Session observability and historical context retrieval.

**What gaal provides.** Rust CLI indexing Claude/Codex JSONL session files into SQLite + Tantivy. Key capabilities:
- `gaal active` -- list running sessions
- `gaal show <id>` -- full session record (files, commands, tokens, tools count)
- `gaal inspect <id>` -- operational snapshot (CPU, RSS, velocity, context usage)
- `gaal recall <topic>` -- semantic session search for continuity
- `gaal ls --sort cost` -- fleet view sorted by cost
- JSON output, agent-optimized brief format (~500 tokens)

**Integration approach: CLI shell-out.** Same pattern as wet.

**No bot-level recall command.** Gaal recall is a skill Claude invokes conversationally -- same pattern as wet compression. The user talks to Claude, Claude uses gaal skill to search past sessions.

**Bot-level integration:**
- `/sessions` command -- calls `gaal ls --limit 5 --engine <current>`, shows recent session history across bot restarts
- `src/integrations/gaal.ts` module available for Claude's skills to call

**Tasks:**
1. Add `src/integrations/gaal.ts` -- async functions: `isGaalAvailable()`, `gaalShow(sessionId)`, `gaalActive()`, `gaalLs(opts)`. Shell out, parse JSON. Timeout 2s.
2. Add `/sessions` command in `bot.ts` -- calls `gaalLs`, formats brief results for TG.

## WS-3: Compaction and Eywa Cleanup

**Goal:** Remove compaction prevention and eywa. Let Claude SDK auto-compact freely. Wet handles context optimization upstream.

**Remove:**

| Target | File | What |
|--------|------|------|
| PreCompact hook | `engine/claude.ts` | `hooks: { PreCompact: [...] }` block returning `{ decision: "block" }` |
| Precompact trigger handling | `session/context-monitor.ts` | `handleContextWarning` branch for precompact |
| `"precompact"` trigger type | `engine/interface.ts` | Remove from `ContextWarningEvent.trigger` union |
| `runClaudeExtraction()` | `session/lifecycle.ts` | Entire function (calls eywa, reads handoffs) |
| Eywa handoff path construction | `session/lifecycle.ts` | `data/eywa/handoffs/` path |
| `"extracted via eywa"` strings | `engine/claude.ts`, `engine/codex.ts` | Remove or change to neutral text |
| `pendingHandoff` field | Session type, lifecycle, query, bot, store | All reads/writes |
| 65%/80% threshold alerts | `session/context-monitor.ts` | `checkContextThresholds` logic, `CONTEXT_PERCENT_THRESHOLDS` |
| `contextAlertedThresholds` | Session type | Threshold tracking field |

**Keep:**
- `/context` command -- on-demand visibility, user asks when they want to know
- `ContextWarningEvent` type with `"threshold"` trigger (for future use if needed)
- `session.lastModelUsage` / `session.cumulativeInputTokens` -- needed for fallback when wet unavailable

**Behavioral change:** Claude SDK auto-compacts when it hits limits. No forced extraction/session reset. No automatic alerts. The user checks context via `/context` when they want to. Wet keeps context lean upstream.

**`performExtraction()` replacement:** Simple session reset (clear session ID, reset counters). For public repo: documented extension point for custom extractors.

**Tasks:**
1. Remove PreCompact hook from `engine/claude.ts` `createQuery()`.
2. Remove precompact handling from `context-monitor.ts` `handleContextWarning()`.
3. Remove `"precompact"` from `ContextWarningEvent.trigger` type.
4. Gut `runClaudeExtraction()`. Replace `performExtraction()` with simple session reset.
5. Remove `pendingHandoff` from Session, PersistedSession, all consumers.
6. Strip 65%/80% threshold alert logic from `context-monitor.ts`.
7. Remove `contextAlertedThresholds` from Session type.
8. Remove `"extracted via eywa"` strings.
9. Verify: `/start` resets sessions, `/stop` cleans up, `/context` still works.

## WS-4: Open Source Extraction

**Repo:** `buildoak/tg-claude-bot`. License: MIT. Fresh repo (not subtree).

**Decisions:**

| Question | Decision |
|----------|----------|
| Repo name | `tg-claude-bot` |
| Codex engine | Include. Documents multi-engine pattern. Users without access use Claude. |
| Context extraction | Simple reset (WS-3). No eywa, no pluggable hook. |
| Voice pipeline | Include (Whisper + ElevenLabs + Kokoro). Env-gated, empty defaults. |
| License | MIT |
| Skill injection | Configurable `CLAUDE_MD_PATH` env var. Default: `process.cwd()` |
| Docker | Defer. `bun run dev` + `start.sh` for v1. |
| Wet/Gaal | Bundle as optional integrations. Env-gated, degrade gracefully. |

**Private only (do not ship):**

| Item | Reason |
|------|--------|
| `start-macupos*.sh` | Machine-specific vault paths |
| `ANALYSIS.md`, `PLAN.md`, `ISSUES.md`, `TESTING.md`, `WIRING-PLAN.md` | Internal docs |
| `.env` | Live secrets |

**Public (modified):**

| Item | Changes |
|------|---------|
| `config.ts` | Generic defaults, env-only secrets |
| `lifecycle.ts` | Stripped eywa, simple reset |
| `bot.ts` | Configurable `BOT_NAME` env var (default "Bot") |
| `index.ts` | Generic startup message |
| `package.json` | Updated metadata, removed personal scripts |

**Public (new):**

| Item | Content |
|------|---------|
| `.env.example` | All env vars documented |
| `README.md` | Features, quick start, commands, architecture, config reference |
| `LICENSE` | MIT |
| `start.sh` | Generic launcher |
| `.gitignore` | Standard |

**Selling points (for README):**
- EngineAdapter abstraction (Claude + Codex in one event stream)
- Message batching for Telegram bursts
- Context monitoring with wet integration (optional)
- Session observability with gaal integration (optional)
- Dual TTS pipeline (cloud + local, env-gated)
- Session management with persistence

**Sanitization checklist:**
- [ ] No hardcoded paths to personal directories
- [ ] No hardcoded user IDs
- [ ] No API keys or tokens
- [ ] No ElevenLabs owner/voice IDs (env vars only)
- [ ] No references to personal projects, names, or internal tools in code comments
- [ ] `grep -r "otonashi\|pratchett\|jenkins\|eywa" src/` returns 0
- [ ] NOISE_PATTERNS in query.ts kept (defensive) but documented

**Tasks:**
1. Create fresh repo `buildoak/tg-claude-bot`.
2. Copy source files, apply WS-3 cleanup first.
3. Parameterize all hardcoded values (bot name, paths, IDs).
4. Create `.env.example`, `README.md`, `LICENSE`, `start.sh`, `.gitignore`.
5. Run sanitization checklist grep.
6. `bun install && bun run check` -- type-check passes.
7. Smoke test with test bot token.
8. Initial commit and push.

## Dependencies

```
WS-3 (cleanup) --> WS-4 (open source)    # must strip eywa before extracting
WS-1 (wet)     --> independent            # parallel, additive
WS-2 (gaal)    --> independent            # parallel, additive
```

Recommended execution order:
1. **WS-3** first -- removes dead code, simplifies lifecycle. Mechanical, low risk. ~2h.
2. **WS-1 + WS-2** in parallel -- both are additive (new `src/integrations/`). Neither touches same files. ~3h each.
3. **WS-4** last -- depends on WS-3. WS-1/WS-2 ship in public repo as optional. ~4h.

Total estimated effort: ~12h across all workstreams.
