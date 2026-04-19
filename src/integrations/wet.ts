import { type Subprocess } from "bun";
import { WET_DISABLED } from "../config";

export interface WetStatus {
  api_input_tokens: number;
  context_window: number;
  items_compressed: number;
  items_total: number;
  tokens_saved: number;
  latest_total_input_tokens: number;
  paused: boolean;
  mode: string;
}

export interface WetInspectItem {
  tool_use_id: string;
  tool_name: string;
  turn: number;
  stale: boolean;
  token_count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWetStatus(value: unknown): value is WetStatus {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNumber(value.api_input_tokens) &&
    isNumber(value.context_window) &&
    isNumber(value.items_compressed) &&
    isNumber(value.items_total) &&
    isNumber(value.tokens_saved) &&
    isNumber(value.latest_total_input_tokens) &&
    typeof value.paused === "boolean" &&
    typeof value.mode === "string"
  );
}

function isWetInspectItem(value: unknown): value is WetInspectItem {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.tool_use_id === "string" &&
    typeof value.tool_name === "string" &&
    isNumber(value.turn) &&
    typeof value.stale === "boolean" &&
    isNumber(value.token_count)
  );
}

async function fetchWetJson(path: string): Promise<unknown | null> {
  const port = process.env.WET_PORT?.trim();
  if (!port) {
    return null;
  }

  try {
    const response = await fetch(`http://localhost:${port}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

export function isWetAvailable(): boolean {
  return Boolean(process.env.WET_PORT?.trim());
}

export async function getWetStatus(): Promise<WetStatus | null> {
  const data = await fetchWetJson("/_wet/status");
  return isWetStatus(data) ? data : null;
}

// --- Wet health check (used by Claude adapter for routing) ---

/**
 * Returns true if wet proxy is reachable and should be used for routing.
 * Wet is a managed child process — it's either alive or not.
 * Quick check, no caching needed since the process lifecycle is managed.
 */
export async function isWetHealthy(): Promise<boolean> {
  const port = process.env.WET_PORT?.trim();
  if (!port) {
    return false;
  }

  try {
    const response = await fetch(`http://localhost:${port}/_wet/status`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getWetInspect(): Promise<WetInspectItem[] | null> {
  const data = await fetchWetJson("/_wet/inspect");
  if (!Array.isArray(data) || !data.every(isWetInspectItem)) {
    return null;
  }

  return data;
}

// ─── Wet process lifecycle (used by index.ts and bot.ts) ─────────────

const DEFAULT_WET_PORT = "3456";

function resolveWetPort(): string {
  return process.env.WET_PORT?.trim() || DEFAULT_WET_PORT;
}

async function waitForWetReady(port: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/_wet/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let wetProcess: Subprocess | null = null;

// PID of an adopted external wet instance (not spawned by us).
// Used to kill orphan wet processes on shutdown/restart.
let adoptedWetPid: number | null = null;

/**
 * Resolve the PID of a process listening on the given TCP port.
 * Uses `lsof` which is available on macOS and most Linux.
 * Returns null if the PID cannot be determined.
 */
async function resolveListenerPid(port: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    // lsof may return multiple PIDs (one per fd); take the first.
    const firstLine = text.trim().split("\n")[0] ?? "";
    const pid = parseInt(firstLine, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Start the wet serve proxy process.
 * Returns the port string on success, null on failure.
 * Safe to call multiple times — detects external instances and reuses them.
 */
export async function startWetServe(): Promise<string | null> {
  if (WET_DISABLED) return null;
  const port = resolveWetPort();

  // Check if wet is already running on this port (external instance)
  try {
    const res = await fetch(`http://localhost:${port}/_wet/status`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      // Adopt the external instance, but track its PID so we can kill it
      // on shutdown/restart. Without this, adopted instances leak as orphans
      // because wetProcess is null and killWetProcess() is a no-op.
      const pid = await resolveListenerPid(port);
      adoptedWetPid = pid;
      console.log(`[wet] external instance already running on port ${port} (adopted pid=${pid ?? "unknown"})`);
      process.env.WET_PORT = port;
      // Don't include /v1 — the Anthropic SDK already prepends /v1 to all API paths.
      // Setting /v1 here would produce /v1/v1/messages → 404.
      process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
      return port;
    }
  } catch {
    // Not running — we'll start it
  }

  try {
    wetProcess = Bun.spawn(["/Users/otonashi/.local/bin/wet", "serve", "--port", port, "--mode", "passthrough"], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, WET_PORT: port },
    });

    const ready = await waitForWetReady(port);
    if (!ready) {
      console.warn("[wet] serve did not become ready in time — continuing without wet");
      killWetProcess();
      return null;
    }

    // Set env vars so the Claude adapter and wet.ts pick them up.
    // Don't include /v1 — the Anthropic SDK already prepends /v1 to all API paths.
    process.env.WET_PORT = port;
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;

    console.log(`[wet] serve started on port ${port} (passthrough mode)`);
    return port;
  } catch (error) {
    console.warn(`[wet] failed to start serve: ${error} — continuing without wet`);
    return null;
  }
}

/**
 * Kill the wet serve process — whether it was spawned by us or adopted.
 *
 * Three cases:
 * 1. wetProcess set → we spawned it, kill the child directly.
 * 2. adoptedWetPid set → external instance we adopted, kill by PID.
 * 3. Neither → true no-op.
 *
 * This fixes the orphan leak: previously, adopted instances had wetProcess=null
 * so killWetProcess() was a no-op and the process survived bot shutdown.
 */
export function killWetProcess(): void {
  if (WET_DISABLED) return;
  if (wetProcess) {
    try {
      wetProcess.kill();
    } catch {
      // already dead
    }
    wetProcess = null;
  } else if (adoptedWetPid !== null) {
    // Kill the adopted external wet instance by PID.
    // This covers: bot restart adopting a stale wet, manual `wet serve` left over,
    // and crashed `wet claude` sessions that left orphan `wet serve` processes.
    try {
      process.kill(adoptedWetPid);
      console.log(`[wet] killed adopted wet process (pid=${adoptedWetPid})`);
    } catch {
      // already dead or PID reused — safe to ignore
    }
    adoptedWetPid = null;
  }
}

/**
 * Kill the current wet proxy and spawn a fresh one.
 * Used on /start to get a clean context tracker for the new session.
 * Returns the port on success, null on failure.
 */
export async function restartWetServe(): Promise<string | null> {
  killWetProcess();
  // Clear env so startWetServe doesn't think an external instance is running
  // from the old managed process (which we just killed)
  delete process.env.ANTHROPIC_BASE_URL;
  // Brief delay to let the killed process release the port.
  // Without this, startWetServe may probe the port before it's freed,
  // see a lingering connection, and adopt a dying process.
  await new Promise((r) => setTimeout(r, 300));
  return startWetServe();
}
