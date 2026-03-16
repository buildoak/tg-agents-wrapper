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

async function main(): Promise<void> {
  console.log("Starting TG agents wrapper bot...");
  console.log(`Working directory: ${WORKING_DIR}`);
  console.log(`Allowed users: ${ALLOWED_USERS.join(", ")}`);
  console.log(`Session file: ${SESSION_FILE}`);
  console.log(`Claude model: ${CLAUDE_MODEL}`);
  console.log(`Codex model: ${CODEX_MODEL}`);
  console.log(`Default engine: ${DEFAULT_ENGINE}`);
  console.log(`Default reasoning effort: ${DEFAULT_REASONING_EFFORT}`);

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
