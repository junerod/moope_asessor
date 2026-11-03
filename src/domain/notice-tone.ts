/**
 * Tom do aviso. Sem IA. Só encurta ou formaliza o texto que já existe.
 */

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export type NoticeTone = "short" | "formal" | "direct";

export function looksLikeToneRewrite(text: string): NoticeTone | null {
  const t = fold(text);
  if (!t || t.length > 80) return null;
  if (/\b(gastei|paguei|recebi|cobrar|cobra|painel|agenda|tarefa)\b/.test(t)) {
    return null;
  }
  if (/mais formal|mais educado|mais cordial/.test(t)) return "formal";
  if (/mais direto/.test(t)) return "direct";
  if (/mais curto|encurta|encurte|resum[ei] o (texto|aviso)/.test(t)) return "short";
  return null;
}

export function rewriteNotice(body: string, tone: NoticeTone): string {
  const raw = String(body || "").replace(/\s+/g, " ").trim();
  if (!raw) return raw;
  if (tone === "short") {
    if (raw.length <= 160) return raw;
    return `${raw.slice(0, 157).replace(/\s+\S*$/, "")}…`;
  }
  if (tone === "direct") {
    return raw.replace(/^oi,?\s+/i, "").slice(0, 220);
  }
  let out = raw.replace(/^oi,?\s+/i, "Olá, ");
  if (!/^ol[aá]/i.test(out)) out = `Olá. ${out}`;
  if (!/por favor/i.test(out)) {
    out = `${out.replace(/[.!?]+$/g, "")}, por favor.`;
  }
  return out.slice(0, 400);
}
