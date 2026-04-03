import { existsSync, unlinkSync } from "fs";

import { KOKORO_DEFAULT_VOICE, KOKORO_PYTHON_PATH, TEMP_DIR } from "../config";
import { splitTextForTTS } from "./tts-elevenlabs";

export interface KokoroConfig {
  voice?: string;
}

export interface KokoroAvailability {
  available: boolean;
  missing: string[];
}

let cachedAvailability: KokoroAvailability | null = null;
let lastCheckTime = 0;
const RECHECK_COOLDOWN_MS = 60_000;

export function clearKokoroAvailabilityCache(): void {
  cachedAvailability = null;
}

export async function isKokoroAvailable(): Promise<KokoroAvailability> {
  if (
    cachedAvailability &&
    (Date.now() - lastCheckTime) < RECHECK_COOLDOWN_MS
  ) {
    return cachedAvailability;
  }

  const missing: string[] = [];

  // Check Python mlx_audio
  try {
    const proc = Bun.spawn([KOKORO_PYTHON_PATH, "-c", "import mlx_audio"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      missing.push(`${KOKORO_PYTHON_PATH} mlx-audio`);
    }
  } catch {
    missing.push(`${KOKORO_PYTHON_PATH} mlx-audio`);
  }

  // Check ffmpeg
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      missing.push("ffmpeg");
    }
  } catch {
    missing.push("ffmpeg");
  }

  lastCheckTime = Date.now();
  cachedAvailability = { available: missing.length === 0, missing };
  return cachedAvailability;
}

export async function kokoroTextToSpeech(text: string, config: KokoroConfig): Promise<Buffer[]> {
  const availability = await isKokoroAvailable();
  if (!availability.available) {
    return [];
  }

  const voice = config.voice || KOKORO_DEFAULT_VOICE;
  const chunks = splitTextForTTS(text, 4000);
  const buffers: Buffer[] = [];

  for (const chunk of chunks) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const filePrefix = `tts_${id}`;
    const wavPath = `${TEMP_DIR}/${filePrefix}.wav`;
    const oggPath = `${TEMP_DIR}/${filePrefix}.ogg`;

    try {
      // Generate WAV via mlx-audio
      const genProc = Bun.spawn(
        [
          KOKORO_PYTHON_PATH,
          "-m",
          "mlx_audio.tts.generate",
          "--model",
          "mlx-community/Kokoro-82M-bf16",
          "--text",
          chunk,
          "--voice",
          voice,
          "--lang_code",
          "a",
          "--output_path",
          TEMP_DIR,
          "--file_prefix",
          filePrefix,
          "--audio_format",
          "wav",
          "--join_audio",
        ],
        { stdout: "pipe", stderr: "pipe" }
      );

      const exitCode = await genProc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(genProc.stderr).text();
        console.error("Kokoro generation failed:", stderr);
        clearKokoroAvailabilityCache();
        continue;
      }

      // The file might be tts_{id}_000.wav or tts_{id}.wav depending on join_audio
      const actualWav = existsSync(wavPath) ? wavPath : `${TEMP_DIR}/${filePrefix}_000.wav`;

      // Convert to OGG/Opus for Telegram
      const ffProc = Bun.spawn(
        ["ffmpeg", "-y", "-i", actualWav, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", oggPath],
        { stdout: "pipe", stderr: "pipe" }
      );

      const ffExit = await ffProc.exited;
      if (ffExit !== 0) {
        const ffStderr = await new Response(ffProc.stderr).text();
        console.error("ffmpeg conversion failed:", ffStderr);
        continue;
      }

      const oggData = await Bun.file(oggPath).arrayBuffer();
      buffers.push(Buffer.from(oggData));

      // Cleanup temp files
      try {
        unlinkSync(actualWav);
      } catch {}
      try {
        unlinkSync(oggPath);
      } catch {}
      if (actualWav !== wavPath) {
        try {
          unlinkSync(wavPath);
        } catch {}
      }
    } catch (err) {
      clearKokoroAvailabilityCache();
      console.error("Kokoro TTS error:", err);
    }
  }

  return buffers;
}
