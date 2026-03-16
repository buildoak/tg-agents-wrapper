import { existsSync, unlinkSync } from "fs";

import { splitTextForTTS } from "./tts-elevenlabs";

export interface KokoroConfig {
  voice?: string;
}

export async function kokoroTextToSpeech(text: string, config: KokoroConfig): Promise<Buffer[]> {
  const voice = config.voice || "af_heart";
  const chunks = splitTextForTTS(text, 4000);
  const buffers: Buffer[] = [];

  for (const chunk of chunks) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const wavPath = `/tmp/tts_${id}.wav`;
    const oggPath = `/tmp/tts_${id}.ogg`;

    try {
      // Generate WAV via mlx-audio
      const genProc = Bun.spawn(
        [
          "python3",
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
          "/tmp",
          "--file_prefix",
          `tts_${id}`,
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
        continue;
      }

      // The file might be tts_{id}_000.wav or tts_{id}.wav depending on join_audio
      const actualWav = existsSync(wavPath) ? wavPath : `/tmp/tts_${id}_000.wav`;

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
      console.error("Kokoro TTS error:", err);
    }
  }

  return buffers;
}
