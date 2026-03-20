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
