/**
 * Regras Meta / Zernio para variáveis de template WhatsApp.
 *
 * - Corpo fixo do template: Enter/\n normal entre linhas.
 * - Dentro de {{n}}: usar \r (Meta barra \n → erro 132018).
 * - Template NÃO pode começar nem terminar com parâmetro.
 */
export function toTemplateParam(value: string | null | undefined): string {
  const raw = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!raw) return "—";
  // Meta: newline dentro do parâmetro = \r
  return raw.replace(/\n/g, "\r");
}

/** Junta linhas com \r (para montar {{1}} rico). */
export function joinTemplateLines(
  lines: Array<string | null | undefined>,
  blankLine = false
): string {
  const sep = blankLine ? "\r\r" : "\r";
  return toTemplateParam(
    lines
      .map((l) => String(l ?? "").trim())
      .filter(Boolean)
      .join(blankLine ? "\n\n" : "\n")
  );
}

/** Troca \n → \r em cada param da lista. */
export function sanitizeTemplateParams(params: string[]): string[] {
  return params.map((p) => toTemplateParam(p));
}
