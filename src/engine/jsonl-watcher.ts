/**
 * JSONL session file watcher — Lane B of dual-lane token tracking.
 *
 * Watches the Claude SDK session JSONL file for new `assistant` events,
 * extracts message.usage, and feeds into SessionTokens store.
 *
 * The JSONL path follows Claude SDK convention:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Lifecycle:
 *   - Started when the first query begins and session ID is known
 *   - Does a one-time full scan to catch up with existing entries
 *   - Then watches for new lines via fs.watch
 *   - Stopped on session reset (/start) or shutdown
 */

import { existsSync, watch, type FSWatcher } from "fs";
import { homedir } from "os";
import { getSessionTokens, type RawUsage } from "./session-tokens";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Encode a cwd path the same way Claude SDK does for the projects directory.
 * Forward slashes and other special chars become hyphens.
 */
function encodeCwd(cwd: string): string {
  // Claude SDK encodes the cwd by replacing ALL path separators with hyphens,
  // including the leading slash — so /Users/foo becomes -Users-foo.
  // Defensive: ensure absolute path even if cwd arrives without leading slash.
  const abs = cwd.startsWith("/") ? cwd : `/${cwd}`;
  return abs.replace(/\//g, "-");
}

function resolveJsonlPath(cwd: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  return `${homedir()}/.claude/projects/${encoded}/${sessionId}.jsonl`;
}

class JsonlWatcher {
  private watcher: FSWatcher | null = null;
  private fileOffset = 0;
  private jsonlPath: string;
  private active = false;

  constructor(
    private cwd: string,
    private sessionId: string
  ) {
    this.jsonlPath = resolveJsonlPath(cwd, sessionId);
  }

  /**
   * Start watching. Does initial scan, then watches for changes.
   */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    if (!existsSync(this.jsonlPath)) {
      console.debug(`[jsonl-watcher] File not found yet: ${this.jsonlPath}`);
      // File may not exist yet (SDK creates it on first write).
      // Start watching the directory instead and pick up the file when it appears.
      this.watchForFileCreation();
      return;
    }

    await this.initialScan();
    this.watchFile();
  }

  stop(): void {
    this.active = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getPath(): string {
    return this.jsonlPath;
  }

  /**
   * Full scan of existing JSONL content — catches up with entries written
   * before the watcher started.
   */
  private async initialScan(): Promise<void> {
    try {
      const file = Bun.file(this.jsonlPath);
      const text = await file.text();
      const lines = text.split("\n").filter(Boolean);

      for (const line of lines) {
        this.processLine(line);
      }

      // Set offset to current file size so we only read new content going forward
      this.fileOffset = text.length;
      console.debug(
        `[jsonl-watcher] Initial scan complete: ${lines.length} lines, offset=${this.fileOffset}`
      );
    } catch (error) {
      console.warn(`[jsonl-watcher] Initial scan failed: ${error}`);
    }
  }

  /**
   * Watch for file changes and read new lines.
   */
  private watchFile(): void {
    if (this.watcher) {
      this.watcher.close();
    }

    try {
      this.watcher = watch(this.jsonlPath, async (eventType) => {
        if (!this.active) return;
        if (eventType === "change") {
          await this.readNewLines();
        }
      });
    } catch (error) {
      console.warn(`[jsonl-watcher] Failed to start file watch: ${error}`);
    }
  }

  /**
   * Watch the parent directory for the JSONL file to appear.
   */
  private watchForFileCreation(): void {
    const dir = this.jsonlPath.substring(0, this.jsonlPath.lastIndexOf("/"));

    try {
      // Check once more in case it appeared between constructor and start
      if (existsSync(this.jsonlPath)) {
        void this.initialScan().then(() => this.watchFile());
        return;
      }

      const dirWatcher = watch(dir, async (_, filename) => {
        if (!this.active) {
          dirWatcher.close();
          return;
        }

        const expectedFilename = `${this.sessionId}.jsonl`;
        if (filename === expectedFilename && existsSync(this.jsonlPath)) {
          dirWatcher.close();
          await this.initialScan();
          this.watchFile();
        }
      });

      // Store so we can clean up on stop
      this.watcher = dirWatcher;
    } catch (error) {
      console.debug(
        `[jsonl-watcher] Cannot watch directory ${dir}: ${error}. Will retry on next query.`
      );
    }
  }

  /**
   * Read new lines since last known offset.
   */
  private async readNewLines(): Promise<void> {
    try {
      const file = Bun.file(this.jsonlPath);
      const size = file.size;

      if (size <= this.fileOffset) return;

      // Read only the new portion
      const blob = file.slice(this.fileOffset, size);
      const newText = await blob.text();
      this.fileOffset = size;

      const lines = newText.split("\n").filter(Boolean);
      for (const line of lines) {
        this.processLine(line);
      }
    } catch (error) {
      console.debug(`[jsonl-watcher] Read error: ${error}`);
    }
  }

  /**
   * Parse a JSONL line and extract usage from assistant messages.
   */
  private processLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) return;

      // Only process assistant messages — they carry message.usage
      if (parsed.type !== "assistant") return;

      const message = parsed.message;
      if (!isRecord(message)) return;

      const usage = message.usage;
      if (!isRecord(usage)) return;

      const rawUsage: RawUsage = {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
        cache_read_input_tokens:
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : undefined,
        cache_creation_input_tokens:
          typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : undefined,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
      };

      getSessionTokens().updateFromJSONL(rawUsage);
    } catch {
      // Malformed line — skip silently
    }
  }
}

// ─── Module-level lifecycle ───────────────────────────────────

let currentWatcher: JsonlWatcher | null = null;

/**
 * Start watching a session's JSONL file. Call when session ID becomes known
 * (after first query event with session_id). Safe to call multiple times —
 * restarts watcher if session ID changes.
 */
export function startJsonlWatcher(cwd: string, sessionId: string): void {
  // Already watching this session
  if (currentWatcher && currentWatcher.getPath() === resolveJsonlPath(cwd, sessionId)) {
    return;
  }

  // Stop previous watcher if any
  stopJsonlWatcher();

  currentWatcher = new JsonlWatcher(cwd, sessionId);
  void currentWatcher.start();
  console.debug(`[jsonl-watcher] Started for session ${sessionId.slice(0, 8)}`);
}

/**
 * Stop the current JSONL watcher. Call on session reset or shutdown.
 */
export function stopJsonlWatcher(): void {
  if (currentWatcher) {
    currentWatcher.stop();
    currentWatcher = null;
  }
}
