import { existsSync, mkdirSync } from "fs";

import type { ReasoningEffort } from "./types";

export const BOT_TOKEN = process.env.TGBOT_API_KEY || "";
export const ALLOWED_USERS = (process.env.TGBOT_ALLOWED_USERS || "")
  .split(",")
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => !Number.isNaN(id));

export const WORKING_DIR = process.env.WORKING_DIR || "./";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const TEMP_DIR = process.env.TG_SESSION_DIR || "/tmp/tg-agents-wrapper";
export const DOCUMENT_FILES_DIR = process.env.TG_FILES_DIR || "/tmp/tg-agents-wrapper-files";
export const SESSION_FILE = `${TEMP_DIR}/sessions.json`;

export const ELEVENLABS_PUBLIC_OWNER_ID = process.env.ELEVENLABS_PUBLIC_OWNER_ID || "";
export const ELEVENLABS_SHARED_VOICE_ID = process.env.DEFAULT_ELEVENLABS_VOICE_ID || "";
export const ELEVENLABS_VOICE_NAME = process.env.ELEVENLABS_VOICE_NAME || "";
export const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
export const KOKORO_DEFAULT_VOICE = process.env.DEFAULT_KOKORO_VOICE || "af_heart";

export const DEFAULT_ENGINE =
  process.env.DEFAULT_ENGINE === "codex" ? "codex" : "claude";

const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const rawEffort = process.env.DEFAULT_REASONING_EFFORT;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort =
  rawEffort && VALID_REASONING_EFFORTS.includes(rawEffort as ReasoningEffort)
    ? (rawEffort as ReasoningEffort)
    : "high";

export const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4";
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";

for (const dir of [TEMP_DIR, DOCUMENT_FILES_DIR]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function validateConfig(): void {
  if (!BOT_TOKEN) {
    throw new Error("Missing required environment variable: TGBOT_API_KEY");
  }
}

export function isAuthorized(userId: number): boolean {
  if (ALLOWED_USERS.length === 0) return false;
  return ALLOWED_USERS.includes(userId);
}

export const config = {
  BOT_TOKEN,
  ALLOWED_USERS,
  WORKING_DIR,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  TEMP_DIR,
  DOCUMENT_FILES_DIR,
  SESSION_FILE,
  ELEVENLABS_PUBLIC_OWNER_ID,
  ELEVENLABS_SHARED_VOICE_ID,
  ELEVENLABS_VOICE_NAME,
  ELEVENLABS_MODEL_ID,
  KOKORO_DEFAULT_VOICE,
  DEFAULT_ENGINE,
  DEFAULT_REASONING_EFFORT,
  CODEX_MODEL,
  CLAUDE_MODEL,
  botToken: BOT_TOKEN,
  allowedUsers: ALLOWED_USERS,
  workingDir: WORKING_DIR,
  openaiApiKey: OPENAI_API_KEY,
  elevenLabsApiKey: ELEVENLABS_API_KEY,
  tempDir: TEMP_DIR,
  documentFilesDir: DOCUMENT_FILES_DIR,
  sessionFilePath: SESSION_FILE,
  defaultVoiceId: ELEVENLABS_SHARED_VOICE_ID,
  elevenLabsPublicOwnerId: ELEVENLABS_PUBLIC_OWNER_ID,
  elevenLabsSharedVoiceId: ELEVENLABS_SHARED_VOICE_ID,
  elevenLabsVoiceName: ELEVENLABS_VOICE_NAME,
  elevenLabsModelId: ELEVENLABS_MODEL_ID,
  kokoroDefaultVoice: KOKORO_DEFAULT_VOICE,
  defaultEngine: DEFAULT_ENGINE,
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  codexModel: CODEX_MODEL,
  claudeModel: CLAUDE_MODEL,
};

validateConfig();
