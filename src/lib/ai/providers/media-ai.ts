import { getEnv } from "@/config/env";
import type { VisionProvider, TranscriptionProvider } from "./types";

export function createOpenAIVisionProvider(apiKey: string): VisionProvider {
  return {
    name: "openai",
    async describe({ buffer, mimeType, prompt }) {
      const b64 = buffer.toString("base64");
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: getEnv().OPENAI_MODEL,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    prompt ||
                    "Extraia texto e dados relevantes desta imagem (nota fiscal, recibo, boleto, documento). Não invente campos ausentes. Responda em português.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType || "image/jpeg"};base64,${b64}`,
                  },
                },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`vision_failed:${res.status}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return { text: data.choices?.[0]?.message?.content || "", mocked: false };
    },
  };
}

export function createStubVisionProvider(): VisionProvider {
  return {
    name: "stub",
    async describe() {
      return { text: "", mocked: true };
    },
  };
}

export function createOpenAITranscriptionProvider(
  apiKey: string
): TranscriptionProvider {
  return {
    name: "openai",
    async transcribe({ buffer, mimeType }) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(buffer)], { type: mimeType || "audio/ogg" }),
        "audio.ogg"
      );
      form.append("model", "whisper-1");
      form.append("language", "pt");
      const res = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        }
      );
      if (!res.ok) throw new Error(`transcription_failed:${res.status}`);
      const data = (await res.json()) as { text?: string };
      return { text: data.text || "", mocked: false };
    },
  };
}

export function createStubTranscriptionProvider(): TranscriptionProvider {
  return {
    name: "stub",
    async transcribe() {
      return { text: "", mocked: true };
    },
  };
}
