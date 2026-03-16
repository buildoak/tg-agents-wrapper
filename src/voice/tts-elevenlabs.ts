export interface ElevenLabsConfig {
  apiKey?: string;
  voiceId?: string | null;
  modelId?: string;
  publicOwnerId?: string;
  sharedVoiceId?: string;
  voiceName?: string;
}

export function splitTextForTTS(text: string, maxLen = 5000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split on sentence boundary
    let splitAt = remaining.lastIndexOf(". ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf("! ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf("? ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < 1) splitAt = maxLen;
    else splitAt += 1; // include the delimiter
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks.filter((c) => c.length > 0);
}

export async function textToSpeech(text: string, config: ElevenLabsConfig): Promise<Buffer[]> {
  if (!config.apiKey) {
    console.warn("ElevenLabs not available for TTS");
    return [];
  }

  const effectiveVoiceId = config.voiceId;
  if (!effectiveVoiceId) {
    console.warn("No ElevenLabs voice ID configured for TTS");
    return [];
  }

  const chunks = splitTextForTTS(text, 5000);
  const buffers: Buffer[] = [];

  for (const chunk of chunks) {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${effectiveVoiceId}?output_format=opus_48000_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": config.apiKey,
            "Content-Type": "application/json",
            Accept: "audio/opus",
          },
          body: JSON.stringify({
            text: chunk,
            model_id: config.modelId || "eleven_flash_v2_5",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error(`TTS error on chunk (${response.status}):`, errText);
        continue;
      }

      buffers.push(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error("TTS error on chunk:", err);
    }
  }

  return buffers;
}

export async function initializeElevenLabs(config: ElevenLabsConfig): Promise<void> {
  if (!config.apiKey) {
    console.log("No ELEVENLABS_API_KEY - ElevenLabs TTS disabled");
    return;
  }

  config.voiceId = config.sharedVoiceId || config.voiceId || null;
  console.log("ElevenLabs configured (TTS enabled)");

  if (!config.publicOwnerId || !config.sharedVoiceId) {
    return;
  }

  const voiceName = config.voiceName || "Edward";

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/voices/add/${config.publicOwnerId}/${config.sharedVoiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ new_name: voiceName }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`ElevenLabs voice add skipped (${response.status}):`, errText);
      return;
    }

    console.log(`ElevenLabs voice ready: ${voiceName}`);
  } catch (err) {
    console.warn("Failed to add ElevenLabs shared voice (continuing):", err);
  }
}
