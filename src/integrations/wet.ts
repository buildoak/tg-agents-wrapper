import { type Subprocess } from "bun";

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

/**
 * Start the wet serve proxy process.
 * Returns the port string on success, null on failure.
 * Safe to call multiple times — detects external instances and reuses them.
 */
export async function startWetServe(): Promise<string | null> {
  const port = resolveWetPort();

  // Check if wet is already running on this port (external instance)
  try {
    const res = await fetch(`http://localhost:${port}/_wet/status`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      console.log(`[wet] external instance already running on port ${port}`);
      process.env.WET_PORT = port;
      process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}/v1`;
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

    // Set env vars so the Claude adapter and wet.ts pick them up
    process.env.WET_PORT = port;
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}/v1`;

    console.log(`[wet] serve started on port ${port} (passthrough mode)`);
    return port;
  } catch (error) {
    console.warn(`[wet] failed to start serve: ${error} — continuing without wet`);
    return null;
  }
}

/**
 * Kill the managed wet serve child process. No-op if no managed process exists.
 */
export function killWetProcess(): void {
  if (wetProcess) {
    try {
      wetProcess.kill();
    } catch {
      // already dead
    }
    wetProcess = null;
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
  return startWetServe();
}
