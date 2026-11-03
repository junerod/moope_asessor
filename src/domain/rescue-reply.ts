import type { Db } from "@/db/client";
import { resolveLanguageModelProvider } from "@/lib/ai/providers";
import { logger } from "@/lib/logger";
import { looksLikeCodeLeak, SAFE_RETRY_REPLY } from "@/domain/safe-reply";

/**
 * Só entra quando um atalho quebrou. Usa o mesmo modelo já configurado
 * (gpt-4o-mini) para responder a pessoa, sem mostrar erro de código.
 */
export async function rescueUserReply(db: Db, userText: string): Promise<string> {
  const asked = String(userText || "").trim().slice(0, 500);
  if (!asked) return SAFE_RETRY_REPLY;
  try {
    const provider = await resolveLanguageModelProvider(db);
    const result = await provider.complete({
      system: [
        "Você é o Assessor MOOPE no WhatsApp.",
        "Responda em português, curto, como pessoa.",
        "Não mostre erro de código, nome de função nem stack.",
        "Não invente placa, valor, quantidade de carro nem vistoria.",
        "Se a pergunta depende da locadora e você não tem o dado, diga que não conseguiu consultar agora e peça para repetir.",
      ].join(" "),
      messages: [{ role: "user", content: asked }],
      tools: [],
    });
    const text = String(result.content || "").trim();
    if (!text || looksLikeCodeLeak(text)) return SAFE_RETRY_REPLY;
    return text;
  } catch (err) {
    logger.warn("rescue_reply_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return SAFE_RETRY_REPLY;
  }
}
