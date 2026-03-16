import { createReadStream } from "fs";

import { OPENAI_TRANSCRIPTION_MODEL } from "../config";

export interface OpenAITranscriptionClient {
  audio: {
    transcriptions: {
      create(params: { model: string; file: unknown }): Promise<{ text: string }>;
    };
  };
}

export async function transcribeVoice(
  filePath: string,
  openaiClient?: OpenAITranscriptionClient | null
): Promise<string | null> {
  if (!openaiClient) {
    console.warn("OpenAI client not available for transcription");
    return null;
  }

  try {
    const transcript = await openaiClient.audio.transcriptions.create({
      model: OPENAI_TRANSCRIPTION_MODEL,
      file: createReadStream(filePath),
    });
    return transcript.text;
  } catch (err) {
    console.error("Transcription error:", err);
    return null;
  }
}
