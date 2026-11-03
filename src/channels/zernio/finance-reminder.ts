/**
 * Lembrete de cliente do MOOPE Gestão (frotas /lembretes).
 * Esse disparo não é conversa do Assessor. Se chegar no webhook, não vira turno.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function outboundDirection(raw: Record<string, unknown>): boolean {
  const data = asRecord(raw.data) || raw;
  const message = asRecord(data.message) || asRecord(raw.message);
  const direction = String(message?.direction || "").toLowerCase();
  return direction === "outgoing" || direction === "outbound";
}

/** Template “Lembrete: … Equipe NOME” do Gestão, não um pedido do usuário. */
export function isFinanceCustomerReminder(text: string | null | undefined): boolean {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return /^lembrete\s*:/i.test(t) && /\bequipe\b/i.test(t);
}
