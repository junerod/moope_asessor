/** Texto que nunca pode ir para o WhatsApp. */
export function looksLikeCodeLeak(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /is not a function|is not defined|cannot read propert|of undefined|of null/i.test(t) ||
    /\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(t) ||
    /at\s+\S+\s+\((\/|[A-Za-z]:\\)/.test(t) ||
    /^[A-Za-z0-9_$.]+ is not a function\.?$/.test(t)
  );
}

export const SAFE_RETRY_REPLY =
  "Não consegui concluir agora. Pode repetir o pedido?";
