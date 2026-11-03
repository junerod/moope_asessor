import { DateTime } from "luxon";

export type ReminderPayload = {
  amount?: number | null;
  note?: string | null;
  kind?: "conta" | "compromisso" | "remedio" | "geral" | string | null;
  emoji?: string | null;
};

function moneyBr(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function emojiForReminder(payload: ReminderPayload, title: string): string {
  if (payload.emoji) return String(payload.emoji);
  const kind = String(payload.kind || "").toLowerCase();
  if (kind === "conta") return "💸";
  if (kind === "remedio") return "💊";
  if (kind === "compromisso") return "📅";
  const t = title.toLowerCase();
  if (/(condom[ií]nio|luz|agua|água|internet|telefone|pagamento|boleto|fatura)/i.test(t))
    return "💸";
  if (/(remedio|remédio|medic)/i.test(t)) return "💊";
  if (/(reuni[aã]o|consulta|visita|compromisso|agenda)/i.test(t)) return "📅";
  return "🔔";
}

/** Smokes / testes internos — nunca listar pro usuário. */
export function isInternalTestReminder(
  title: string,
  payload?: ReminderPayload | Record<string, unknown> | null
): boolean {
  const t = String(title || "");
  if (/confiabilidade\s+alertas/i.test(t)) return true;
  if (/^🔧?\s*teste\b/i.test(t.trim())) return true;
  if (/\b(smoke_alert|teste sync google)\b/i.test(t)) return true;
  const note = String(
    (payload as ReminderPayload | null | undefined)?.note || ""
  );
  if (/smoke_alert|__internal_test__/i.test(note)) return true;
  return false;
}

/** Linha bonita pra listagem no WhatsApp. */
export function formatReminderListItem(input: {
  title: string;
  fireAt: Date;
  timezone: string;
  payload?: ReminderPayload | null;
  recurrenceRule?: string | null;
  status?: string | null;
}): string {
  const payload = (input.payload || {}) as ReminderPayload;
  const status = String(input.status || "").toLowerCase();
  const done = status === "sent";
  const title = input.title
    .replace(/^(lembrete|compromisso)\s*:\s*/i, "")
    .replace(/^(amanh[ãa]|hoje)\s*[:,\-]\s*/i, "")
    .replace(/^[,:\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim() || input.title.trim();
  const emoji = done ? "✅" : emojiForReminder(payload, title);
  const when = DateTime.fromJSDate(input.fireAt).setZone(input.timezone);
  const whenTxt = when.toFormat("dd/LL · HH:mm");
  const amount =
    typeof payload.amount === "number" && Number.isFinite(payload.amount) && payload.amount > 0
      ? ` · ${moneyBr(payload.amount)}`
      : "";
  const recur = input.recurrenceRule ? " · 🔁" : "";
  const tag = done ? " · _já avisei_" : "";
  return `• ${emoji} *${title}*${amount}${tag}\n  🗓️ ${whenTxt}${recur}`;
}

/** Tira chave interna. O Zap mostra o assunto que a pessoa escreveu. */
export function visibleReminderNote(
  note: string | null | undefined,
  title: string
): string {
  const lines = String(note || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^appointment:[0-9a-f-]{8,}$/i.test(line)) return false;
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          line
        )
      ) {
        return false;
      }
      return true;
    });
  const body = lines.join("\n").trim();
  if (!body) return "";
  if (body.toLowerCase() === title.trim().toLowerCase()) return "";
  return body;
}

/** Mensagem de disparo no WhatsApp — curta, legível, com ícone e detalhes. */
export function formatReminderDelivery(input: {
  title: string;
  fireAt: Date;
  timezone: string;
  payload?: ReminderPayload | null;
}): string {
  const payload = (input.payload || {}) as ReminderPayload;
  const emoji = emojiForReminder(payload, input.title);
  const when = DateTime.fromJSDate(input.fireAt).setZone(input.timezone);
  const datePart = when.toFormat("dd/LL");
  const timePart = when.toFormat("HH:mm");

  const lines = [`${emoji} *Lembrete*`, input.title.trim()];

  const amount =
    typeof payload.amount === "number" && Number.isFinite(payload.amount)
      ? payload.amount
      : null;
  if (amount != null && amount > 0) {
    lines.push(`💰 ${moneyBr(amount)}`);
  }

  const note = visibleReminderNote(payload.note, input.title);
  if (note) {
    lines.push(`📝 ${note.slice(0, 180)}`);
  }

  lines.push(`🗓️ ${datePart} · ${timePart}`);

  const sharedFrom = (payload as { shared_from?: { name?: string } }).shared_from;
  if (sharedFrom?.name) {
    lines.unshift(`📩 *Recado de ${String(sharedFrom.name)}*`);
  }

  // Conta/boleto: pede comprovante na hora (estado setado no worker)
  const kind = String(payload.kind || "").toLowerCase();
  const billLike =
    kind === "conta" ||
    /(conta|boleto|fatura|pagamento|pagar|condom[ií]nio|luz|agua|água|internet|telefone|cart[aã]o|aluguel)/i.test(
      input.title
    );
  if (billLike && !sharedFrom) {
    lines.push("");
    lines.push(
      "📸 Manda a foto do *comprovante* que eu arquivo — ou diga *já paguei* / *depois*."
    );
  }

  return lines.join("\n");
}

export function formatReminderConfirm(input: {
  title: string;
  fireAt: Date;
  timezone: string;
  payload?: ReminderPayload | null;
  /** bullet = item de lista; single = confirmação sozinha */
  mode?: "single" | "bullet";
}): string {
  const payload = (input.payload || {}) as ReminderPayload;
  const emoji = emojiForReminder(payload, input.title);
  const when = DateTime.fromJSDate(input.fireAt).setZone(input.timezone);
  const fullWhen = when.toFormat("dd/LL/yyyy HH:mm");
  const shortWhen = when.toFormat("dd/LL · HH:mm");
  const amount =
    typeof payload.amount === "number" && Number.isFinite(payload.amount)
      ? ` · ${moneyBr(payload.amount)}`
      : "";
  const mode = input.mode || "single";
  if (mode === "bullet") {
    return `• ${emoji} *${input.title}*${amount}\n  🗓️ ${shortWhen}`;
  }
  return `${emoji} Pronto — te lembro de *${input.title}*${amount}\n🗓️ ${fullWhen}`;
}

/** Bloco WhatsApp para 1+ lembretes criados no mesmo turno. */
export function formatReminderConfirmBlock(
  items: Array<{
    title: string;
    fireAt: Date;
    timezone: string;
    payload?: ReminderPayload | null;
  }>
): string {
  if (!items.length) return "";
  if (items.length === 1) {
    return formatReminderConfirm({ ...items[0], mode: "single" });
  }
  const lines = [
    `✅ Pronto — anotei *${items.length} lembretes*:`,
    "",
    ...items.map((item) =>
      formatReminderConfirm({ ...item, mode: "bullet" })
    ),
  ];
  return lines.join("\n");
}
