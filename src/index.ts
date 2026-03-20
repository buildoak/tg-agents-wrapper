import { type Subprocess } from "bun";
import OpenAI from "openai";

import { createBot } from "./bot";
import {
  ALLOWED_USERS,
  BOT_NAME,
  BOT_TOKEN,
  CLAUDE_MODEL,
  CODEX_MODEL,
  DEFAULT_ENGINE,
  DEFAULT_REASONING_EFFORT,
  DOCUMENT_FILES_DIR,
  ELEVENLABS_API_KEY,
  ELEVENLABS_MODEL_ID,
  ELEVENLABS_PUBLIC_OWNER_ID,
  ELEVENLABS_SHARED_VOICE_ID,
  ELEVENLABS_VOICE_NAME,
  KOKORO_DEFAULT_VOICE,
  OPENAI_API_KEY,
  SESSION_FILE,
  WET_PORT,
  WORKING_DIR,
} from "./config";
import { ClaudeAdapter } from "./engine/claude";
import { CodexAdapter } from "./engine/codex";
import { type EngineAdapter } from "./engine/interface";
import { abortUserQuery } from "./session/lifecycle";
import { SessionStore } from "./session/store";
import { type EngineType } from "./types";
import { cleanupOldFiles } from "./util/cleanup";
import { initializeElevenLabs } from "./voice/tts-elevenlabs";
import { isKokoroAvailable } from "./voice/tts-kokoro";

// ─── Managed wet serve process ────────────────────────────────

const DEFAULT_WET_PORT = "3456";

function resolveWetPort(): string {
  return WET_PORT || DEFAULT_WET_PORT;
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

async function startWetServe(): Promise<string | null> {
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
    wetProcess = Bun.spawn(["wet", "serve", "--port", port, "--mode", "passthrough"], {
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

function killWetProcess(): void {
  if (wetProcess) {
    try {
      wetProcess.kill();
    } catch {
      // already dead
    }
    wetProcess = null;
  }
}

async function main(): Promise<void> {
  console.log("Starting TG agents wrapper bot...");
  console.log(`Working directory: ${WORKING_DIR}`);
  console.log(`Allowed users: ${ALLOWED_USERS.join(", ")}`);
  console.log(`Session file: ${SESSION_FILE}`);
  console.log(`Claude model: ${CLAUDE_MODEL}`);
  console.log(`Codex model: ${CODEX_MODEL}`);
  console.log(`Default engine: ${DEFAULT_ENGINE}`);
  console.log(`Default reasoning effort: ${DEFAULT_REASONING_EFFORT}`);

  // Start managed wet serve process for accurate context tracking
  await startWetServe();

  const sessionStore = new SessionStore(SESSION_FILE);
  await sessionStore.load();

  const claudeAdapter = new ClaudeAdapter({
    model: CLAUDE_MODEL,
    workingDir: WORKING_DIR,
  });

  const codexAdapter = new CodexAdapter({
    // No apiKey — Codex SDK uses OAuth tokens from ~/.codex/auth.json (subscription billing).
    // OPENAI_API_KEY is reserved for voice transcription (Whisper) only.
    model: CODEX_MODEL,
    workingDir: WORKING_DIR,
    sandboxMode: "danger-full-access",
    networkAccess: true,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  });

  const engines: Record<EngineType, EngineAdapter> = {
    claude: claudeAdapter,
    codex: codexAdapter,
  };

  for (const adapter of Object.values(engines)) {
    if (adapter.start) {
      await adapter.start();
    }
  }

  const openaiClient = OPENAI_API_KEY
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

  if (openaiClient) {
    console.log("OpenAI client initialized (voice transcription available)");
  } else {
    console.log("No OPENAI_API_KEY - voice transcription disabled");
  }

  await initializeElevenLabs({
    apiKey: ELEVENLABS_API_KEY,
    voiceId: ELEVENLABS_SHARED_VOICE_ID,
    modelId: ELEVENLABS_MODEL_ID,
    publicOwnerId: ELEVENLABS_PUBLIC_OWNER_ID,
    sharedVoiceId: ELEVENLABS_SHARED_VOICE_ID,
    voiceName: ELEVENLABS_VOICE_NAME,
  });

  const kokoro = await isKokoroAvailable();
  if (kokoro.available) {
    console.log("Kokoro TTS ready (local MLX)");
  } else {
    console.log(
      `Kokoro TTS unavailable (missing: ${kokoro.missing.join(", ")}) — ElevenLabs only`
    );
  }

  const { bot, bufferManager } = createBot({
    token: BOT_TOKEN,
    store: sessionStore,
    engines,
    openaiClient,
    workingDir: WORKING_DIR,
    documentFilesDir: DOCUMENT_FILES_DIR,
    ttsConfig: {
      elevenLabs: {
        apiKey: ELEVENLABS_API_KEY,
        voiceId: ELEVENLABS_SHARED_VOICE_ID,
        modelId: ELEVENLABS_MODEL_ID,
        publicOwnerId: ELEVENLABS_PUBLIC_OWNER_ID,
        sharedVoiceId: ELEVENLABS_SHARED_VOICE_ID,
        voiceName: ELEVENLABS_VOICE_NAME,
      },
      kokoro: {
        voice: KOKORO_DEFAULT_VOICE,
      },
    },
  });

  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`\n${signal} received - shutting down gracefully...`);

    for (const [userId, session] of sessionStore.getAll().entries()) {
      if (!session.abortController && !session.isQueryActive) {
        continue;
      }

      console.log(`Aborting query for user ${userId}`);
      await abortUserQuery(userId, engines[session.engine] ?? engines.claude, sessionStore);
    }

    await bufferManager.clearAll();

    try {
      await sessionStore.save();
      console.log("Sessions saved.");
    } catch (error) {
      console.error("Failed to save sessions during shutdown:", error);
    }

    try {
      bot.stop();
      console.log("Bot stopped.");
    } catch {
      // ignore if already stopped
    }

    for (const adapter of Object.values(engines)) {
      if (adapter.dispose) {
        try {
          await adapter.dispose();
        } catch (error) {
          console.error(`Failed to dispose ${adapter.name} adapter:`, error);
        }
      }
    }

    killWetProcess();

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    console.log("Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT").catch((error) => {
      console.error("Shutdown error:", error);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM").catch((error) => {
      console.error("Shutdown error:", error);
      process.exit(1);
    });
  });

  const cleanedFiles = cleanupOldFiles(DOCUMENT_FILES_DIR);
  if (cleanedFiles > 0) {
    console.log(`Cleaned up ${cleanedFiles} old uploaded files.`);
  }

  bot.start({
    drop_pending_updates: true,
    onStart: () => {
      console.log(`${BOT_NAME} started, old updates dropped`);
    },
  });
}

void main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
