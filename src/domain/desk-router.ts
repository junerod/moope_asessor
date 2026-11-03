/**
 * Mesas invisíveis: Agenda, Dinheiro, Recados.
 * A pessoa fala com o Assessor. Não precisa chamar ninguém pelo nome.
 */
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";
import { getTool, type ToolContext } from "@/agent/tools/registry";
import { hasExplicitClockTime, parseNaturalDateTime } from "@/lib/datetime";
import {
  buildCreateAppointmentArgs,
  looksLikeAppointmentCreate,
} from "@/domain/appointment-intent";
import { facejusAgendaKind } from "@/domain/facejus-commands";
import { looksLikeToneRewrite, rewriteNotice } from "@/domain/notice-tone";

export type MeetingChannel = "meet" | "presencial" | "telefone";

type NoticeStep = "ask_day" | "ask_notify" | "ask_phone" | "confirm_card" | "ask_time" | "confirm_text";

type DeskPending =
  | {
      kind: "meeting";
      step: "channel" | NoticeStep;
      title: string;
      startsAtIso: string;
      names: string[];
      timezone: string;
      channel?: MeetingChannel | null;
      whenLabel?: string;
      body?: string;
      pendingPhone?: string;
      cardName?: string;
      expiresAt?: string;
    }
  | {
      kind: "charge";
      step: NoticeStep;
      name: string;
      amount: string | null;
      fireAtIso: string;
      whenLabel: string;
      body: string;
      timezone: string;
      needsHour?: boolean;
      pendingPhone?: string;
      cardName?: string;
      purpose?: "payment" | "talk";
      workspaceId?: string;
      expiresAt?: string;
    };

const DESK_PENDING_TTL_MS = 20 * 60 * 1000;

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function mentionsOtherPeople(text: string): boolean {
  const t = fold(text);
  if (/\b(cobrar|cobra|cobre)\b/.test(t)) return true;
  if (/\breuniao\b/.test(t) && /\bcom\b/.test(t)) return true;
  if (/\b(marcar|marque|agenda|agendar)\b/.test(t) && /\bcom\b/.test(t)) return true;
  if (/\bfalar com\b/.test(t)) return true;
  if (/\bavis(?:a|e|ar)\s+(?:a|o|as|os)\s+[a-z]{2,}/.test(t) && !/\bme avis/.test(t)) {
    return true;
  }
  return false;
}

export function looksLikeChargeSomeone(text: string): boolean {
  return /\b(cobrar|cobra|cobre)\b/i.test(fold(text));
}

/** Mandar a cobrança agora, não perguntar o dia. */
export function looksLikeChargeNow(text: string): boolean {
  const t = fold(text);
  if (/\bagora nao\b/.test(t)) return false;
  return /\b(agora|ja|imediatamente)\b/.test(t);
}

export function resolveChargeWhen(
  text: string,
  timezone: string
): { fireAtIso: string; whenLabel: string; sendNow: boolean; needsHour: boolean } | null {
  const sendNow = looksLikeChargeNow(text);
  const when = parseNaturalDateTime(text, timezone);
  if (sendNow) {
    const now = DateTime.now().setZone(timezone);
    return {
      fireAtIso: now.toUTC().toISO() || new Date().toISOString(),
      whenLabel: when?.isValid ? formatDeskDay(when) : "agora",
      sendNow: true,
      needsHour: false,
    };
  }
  if (!when?.isValid) return null;
  const due = formatDeskDay(when);
  if (!hasExplicitClockTime(text)) {
    const now = DateTime.now().setZone(timezone);
    return {
      fireAtIso: now.toUTC().toISO() || new Date().toISOString(),
      whenLabel: due,
      sendNow: true,
      needsHour: false,
    };
  }
  return {
    fireAtIso: when.toUTC().toISO() || "",
    whenLabel: due,
    sendNow: false,
    needsHour: false,
  };
}

export function detectMeetingChannel(text: string): MeetingChannel | null {
  const t = fold(text);
  if (/\b(google meet|meet|videochamada|videoconferencia)\b/.test(t)) return "meet";
  if (/\b(presencial|pessoalmente)\b/.test(t)) return "presencial";
  if (/\b(telefone|ligacao|ligar)\b/.test(t)) return "telefone";
  return null;
}

export function extractPeopleNames(text: string): string[] {
  const clipped = String(text || "")
    .replace(
      /(?:amanh[ãa]|hoje|segunda|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|às|as)\s+.*/i,
      ""
    )
    .replace(/\d{1,2}\s*h.*/i, "");
  const match = clipped.match(/\bcom\s+(.+)$/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(/\s+e\s+|,\s*/i)
    .map((part) => part.replace(/^(?:a|o|as|os)\s+/i, "").replace(/[?.!,]+$/g, "").trim())
    .filter((name) => name.length >= 2 && !/^(pra|para|mim|voce|você)$/i.test(name))
    .slice(0, 6);
}

export function extractTalkName(text: string): string | null {
  const match = String(text || "").match(
    /\bfalar com\s+(?:a\s+|o\s+|as\s+|os\s+)?([A-Za-zÀ-ÿ]{2,})/i
  );
  if (!match?.[1]) return null;
  if (/^(que|de|do|da|pra|para|mim|voce|você)$/i.test(match[1])) return null;
  return match[1];
}

const NOT_A_PERSON =
  /^(que|de|do|da|dos|das|dele|dela|deles|delas|ele|ela|eles|elas|isso|este|esta|esse|essa|aquele|aquilo|para|pra|pro|pagar|me|na|no|em|ate|até|hoje|amanha|sexta|sabado)$/i;

function titlePerson(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function extractChargeName(text: string): string | null {
  const raw = String(text || "");
  const debtor =
    raw.match(/(?:^|[,\s])(?:o|a)\s+([A-Za-zÀ-ÿ]{2,40})\s+me deve/i) ||
    raw.match(/\b([A-Za-zÀ-ÿ]{2,40})\s+me deve/i);
  if (debtor?.[1] && !NOT_A_PERSON.test(debtor[1])) return titlePerson(debtor[1]);

  const match = raw.match(/\bcobr\w*\s+(?:o\s+|a\s+|do\s+|da\s+|de\s+)?([A-Za-zÀ-ÿ]{2,40})/i);
  if (!match?.[1] || NOT_A_PERSON.test(match[1])) return null;
  return titlePerson(match[1]);
}

const DESK_WEEKDAYS = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

/** Dia curto do Zap: “sexta 10/10”. */
export function formatDeskDay(dt: DateTime): string {
  const name = DESK_WEEKDAYS[dt.weekday] || dt.setLocale("pt-BR").toFormat("cccc");
  return `${name} ${dt.toFormat("dd/LL")}`;
}

/** Relógio curto: 19h ou 19h30. Nunca 19:00. */
export function formatDeskClock(dt: DateTime): string {
  if (dt.minute === 0) return `${dt.hour}h`;
  return `${dt.hour}h${String(dt.minute).padStart(2, "0")}`;
}

/** “sexta 10/10 · 19h”. */
export function formatDeskMoment(dt: DateTime): string {
  return `${formatDeskDay(dt)} · ${formatDeskClock(dt)}`;
}

/** Valor no Zap: R$ 50,00. */
export function formatDeskMoney(amount: string | null | undefined): string | null {
  if (!amount) return null;
  const raw = String(amount).replace(/r\$\s*/i, "").trim();
  if (!raw) return null;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const [ints, dec] = value.toFixed(2).split(".");
  const grouped = ints.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${grouped},${dec}`;
}

export function extractMoney(text: string): string | null {
  const raw = String(text || "");
  const tagged =
    raw.match(/r\$\s*(\d+(?:[.,]\d{1,2})?)/i) ||
    raw.match(/(\d+(?:[.,]\d{1,2})?)\s*reais/i);
  if (tagged?.[1]) return `R$ ${tagged[1].replace(".", ",")}`;
  const stripped = raw
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}h\d{0,2}\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\bdia\s+\d{1,2}\b/gi, " ");
  const bare = stripped.match(/\b(\d{1,6}(?:[.,]\d{1,2})?)\b/);
  if (!bare?.[1]) return null;
  return `R$ ${bare[1].replace(".", ",")}`;
}

export function askNotifyHour(name: string, whenLabel: string): string {
  return `Que horas eu aviso *${name}*? O dia fica ${whenLabel}.`;
}

/** Comando novo. Não é texto de aviso nem resposta da lista de convidados. */
export function isFreshCommand(text: string): boolean {
  const t = fold(text);
  if (!t) return false;
  if (looksLikeAppointmentCreate(text)) return false;
  if (/o que tenho|compromissos?|lembretes?|baixa\b|locadora|processo|escritorio/.test(t)) {
    return true;
  }
  if (/sincroniz|agenda google|google agenda|conectar google|desconectar google/.test(t)) {
    return true;
  }
  if (/\b(gastei|paguei|recebi|painel)\b/.test(t)) return true;
  if (/\bchoque\b/.test(t)) return true;
  if (/\bhorarios?\s+livres?\b/.test(t) || /\b(manha|tarde)\s+livre\b/.test(t)) {
    return true;
  }
  if (/quem me deve|a quem eu devo|como esta o teto|gastos do mes/.test(t)) return true;
  if (/\bata\b/.test(t) || /link pra (a )?pessoa marcar|relatorio de tarefas/.test(t)) {
    return true;
  }
  if (/convite (do |no )?(gmail|e-mail|email|google)|puxa (o )?convite/.test(t)) {
    return true;
  }
  if (/saiu do padrao|fora do padrao|gasto estranho/.test(t)) return true;
  if (/documentos da pasta|guarda na pasta|tarefas atrasadas|o que atrasou/.test(t)) {
    return true;
  }
  if (/(telefone|numero|zap|contato).{0,20}(troca|muda|corrige|errado|errei)/.test(t)) {
    return true;
  }
  if (/(troca|muda|corrige|errei).{0,20}(telefone|numero|zap|contato)/.test(t)) {
    return true;
  }
  return false;
}

/** Desistiu do rascunho. Igual WhatsApp: cancelar e segue a vida. */
export function isAbandon(text: string): boolean {
  return /^(cancelar|cancela|desfaz|desfazer|deixa|deixa pra la|esquece|desisto|para)[.!?]?$/i.test(
    fold(text)
  );
}

/** Texto de aviso, não assunto novo. */
export function looksLikeNoticeRewrite(text: string): boolean {
  const raw = String(text || "").trim();
  const t = fold(raw);
  if (!t || t.length < 4) return false;
  if (/^(oi|ola|eai|e ai)\b/.test(t)) return true;
  if (/^(escreve|escreva|o texto|fica assim|manda assim)/.test(t)) return true;
  if (t.length >= 20 && /[.!]/.test(raw) && !/\?$/.test(raw)) return true;
  return false;
}

function looksLikeAmountFix(text: string): boolean {
  return /^(?:o\s+)?valor(?:\s+d[oa]\s+.+?)?\s+[eé]\s*(?:r\$\s*)?\d/i.test(fold(text));
}

export function isExpectedDeskAnswer(
  text: string,
  pending: { kind: string; step: string; timezone?: string }
): boolean {
  if (yes(text) || no(text) || isAbandon(text) || looksLikeAmountFix(text)) return true;
  if (looksLikeChargeSomeone(text)) return false;
  if (/\bfalar com\b/i.test(text)) return false;
  if (looksLikeAppointmentCreate(text) && mentionsOtherPeople(text)) return false;
  if (pending.kind === "meeting" && pending.step === "channel") {
    return detectMeetingChannel(text) != null;
  }
  if (pending.step === "ask_day") {
    if (looksLikeChargeNow(text)) return true;
    return parseNaturalDateTime(text, pending.timezone || "America/Sao_Paulo")?.isValid === true;
  }
  if (pending.step === "ask_notify" || pending.step === "confirm_card") {
    return yes(text) || no(text);
  }
  if (pending.step === "ask_phone") {
    return /(\+?\d[\d\s().-]{8,}\d)/.test(text);
  }
  if (pending.step === "ask_time") {
    return hasExplicitClockTime(text);
  }
  if (pending.step === "confirm_text") {
    if (looksLikeToneRewrite(text)) return true;
    return looksLikeNoticeRewrite(text);
  }
  return false;
}

export function looksLikeCalendarSync(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  if (/sincroniz/.test(t) && /agenda|google|calend/.test(t)) return true;
  return /^(agenda google|google agenda|sincronizar agenda|sincronizar a agenda)[.!?]?$/.test(t);
}

export function looksLikeDayList(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 120 || looksLikeCalendarSync(text)) return false;
  if (facejusAgendaKind(text)) return false;
  if (looksLikeAppointmentCreate(text)) return false;
  if (/\b(baix(?:a|ar)|conclu|dei baixa|dar baixa)\b/.test(t)) return false;
  if (/\b(remover|remove|cancelar|cancela|desmarcar|desmarca)\b/.test(t)) return false;
  if (/\b(anotar|anota|agendar|marcar|marque|ligar)\b/.test(t)) return false;
  return /o que (eu )?tenho|o q (eu )?tenho|oq (eu )?tenho|quais\s+compromissos|meus?\s+compromissos|compromissos?\s+(de|hoje|amanha)|lembretes?( de)? (hoje|amanha)|minha agenda|meu dia|agenda de (hoje|amanha)/.test(
    t
  );
}

async function readPending(db: Db, userId: string): Promise<DeskPending | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const profile = (user?.profileJson || {}) as Record<string, unknown>;
  const pending = profile.desk_pending;
  if (!pending || typeof pending !== "object") return null;
  const row = pending as DeskPending;
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
    await writePending(db, userId, null);
    return null;
  }
  if (row.kind === "charge") {
    return { ...row, kind: "charge", step: row.step || "ask_notify" };
  }
  if (row.kind === "meeting") {
    return { ...row, kind: "meeting", step: row.step || "channel" };
  }
  return null;
}

async function writePending(db: Db, userId: string, pending: DeskPending | null): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;
  const profile = { ...((user.profileJson || {}) as Record<string, unknown>) };
  if (pending) {
    profile.desk_pending = {
      ...pending,
      expiresAt: new Date(Date.now() + DESK_PENDING_TTL_MS).toISOString(),
    };
  } else delete profile.desk_pending;
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

function yes(text: string): boolean {
  return /^(sim|pode|manda|quero|avisa|avise)[.!?]?$/i.test(text.trim());
}

function no(text: string): boolean {
  return /^(n[aã]o|cancela|deixa)[.!?]?$/i.test(text.trim());
}

function chargeNeedsHour(pending: DeskPending): boolean {
  if (pending.kind !== "charge") return false;
  if (pending.whenLabel === "agora") return false;
  if (pending.needsHour === false) return false;
  if (pending.needsHour === true) return true;
  return !/\d{1,2}:\d{2}|\d{1,2}h/i.test(pending.whenLabel || "");
}

function clockOnDay(iso: string, timezone: string, text: string): string | null {
  if (!hasExplicitClockTime(text)) return null;
  const parsed = parseNaturalDateTime(text, timezone);
  if (!parsed?.isValid) return null;
  const base = DateTime.fromISO(iso).setZone(timezone);
  if (!base.isValid) return null;
  const next = base.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
  return next.toUTC().toISO() || iso;
}

async function afterPhoneSaved(
  db: Db,
  userId: string,
  pending: DeskPending
): Promise<string> {
  if (pending.kind === "charge" && pending.purpose !== "talk") {
    if (chargeNeedsHour(pending)) {
      await writePending(db, userId, { ...pending, step: "ask_time" });
      return askNotifyHour(pending.name, pending.whenLabel);
    }
    return dispatchChargeNotice(db, userId, pending);
  }
  if (chargeNeedsHour(pending) && pending.kind === "charge") {
    await writePending(db, userId, { ...pending, step: "ask_time" });
    return askNotifyHour(pending.name, pending.whenLabel);
  }
  return showDraft(db, userId, pending);
}

export async function resumeNoticeFromSharedContact(
  db: Db,
  userId: string,
  card: { name: string; phoneE164: string }
): Promise<string | null> {
  const pending = await readPending(db, userId);
  if (!pending || pending.step !== "ask_phone") return null;
  const expected = pending.kind === "charge" ? pending.name : pending.names[0] || "";
  const { upsertFamilyContact } = await import("@/domain/family-contacts");
  await upsertFamilyContact(db, userId, {
    name: expected || String(card.name || "").trim(),
    phone: card.phoneE164,
    via: "share",
  });
  return afterPhoneSaved(db, userId, pending);
}

export function buildChargeNotice(
  owner: string,
  name: string,
  amount: string | null,
  whenLabel: string
): string {
  const shown = formatDeskMoney(amount);
  const money = shown ? ` de ${shown}` : "";
  const due = whenLabel && whenLabel !== "agora" ? ` até ${whenLabel}` : "";
  return `Oi, ${name}. ${owner} pediu para te lembrar do pagamento${money}${due}.`;
}

export function buildMeetingNotice(
  owner: string,
  name: string,
  whenLabel: string,
  channel: MeetingChannel | null | undefined
): string {
  const place =
    channel === "meet"
      ? ", por Google Meet"
      : channel === "telefone"
        ? ", por telefone"
        : channel === "presencial"
          ? ", presencial"
          : "";
  return `Oi, ${name}. ${owner} pediu para te lembrar da reunião em ${whenLabel}${place}.`;
}

export function buildTalkNotice(owner: string, name: string, whenLabel: string): string {
  return `Oi, ${name}. ${owner} pediu para te lembrar de falar em ${whenLabel}.`;
}

async function ownerFirstName(db: Db, userId: string): Promise<string> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const full = String(user?.fullName || "").trim();
  return full.split(/\s+/)[0] || "Alguém";
}

export async function routeDeskTurn(
  db: Db,
  input: {
    userId: string;
    text: string;
    timezone: string;
    toolCtx: ToolContext;
  }
): Promise<string | null> {
  const text = String(input.text || "").trim();
  if (!text) return null;
  if (isFreshCommand(text) || isAbandon(text)) {
    const had = await readPending(db, input.userId);
    await writePending(db, input.userId, null);
    if (isAbandon(text) && had) return "Beleza, desisti.";
    return null;
  }

  if (looksLikeAppointmentCreate(text)) {
    const wantsNotice =
      /\b(avisa|avise|avisar)\b/.test(fold(text)) && !/\bme avis/.test(fold(text));
    const invite = /\breuniao\b/.test(fold(text)) && /\bcom\b/.test(fold(text));
    if (!wantsNotice && !invite) return null;
  }

  const pending = await readPending(db, input.userId);
  const stayWithPending = pending && isExpectedDeskAnswer(text, pending);
  if (pending && !stayWithPending) {
    await writePending(db, input.userId, null);
  }
  if (stayWithPending && pending?.kind === "meeting" && pending.step === "channel") {
    const channel = detectMeetingChannel(text);
    if (!channel) return "Presencial, Google Meet ou telefone?";
    return afterMeetingChannel(db, input, pending, channel);
  }
  if (
    stayWithPending &&
    (pending?.kind === "charge" || (pending?.kind === "meeting" && pending.step !== "channel"))
  ) {
    return continueNotice(db, input, pending);
  }

  if (/\bfalar com\b/i.test(text)) {
    const name = extractTalkName(text);
    if (!name) return "Com quem? Me diz o nome.";
    const when = parseNaturalDateTime(text, input.timezone);
    if (!when?.isValid) {
      await writePending(db, input.userId, {
        kind: "charge",
        step: "ask_day",
        name,
        amount: null,
        fireAtIso: "",
        whenLabel: "",
        body: "",
        timezone: input.timezone,
        needsHour: true,
        purpose: "talk",
      });
      return `Que dia eu te lembro de falar com *${name}*?`;
    }
    const whenLabel = formatDeskDay(when);
    await writePending(db, input.userId, {
      kind: "charge",
      step: "ask_notify",
      name,
      amount: null,
      fireAtIso: when.toUTC().toISO() || "",
      whenLabel,
      body: "",
      timezone: input.timezone,
      needsHour: !hasExplicitClockTime(text),
      purpose: "talk",
    });
    return [
      `Falar com *${name}*, ${whenLabel}.`,
      "",
      `Quer que eu avise *${name}* também?`,
      "Responda *sim* ou *não*.",
    ].join("\n");
  }

  if (looksLikeChargeSomeone(text)) {
    const name = extractChargeName(text);
    if (!name) return "Quem eu cobro? Me diz o nome.";
    const { recordIouFromText } = await import("@/domain/personal-iou");
    await recordIouFromText(db, {
      workspaceId: input.toolCtx.workspaceId,
      userId: input.userId,
      text,
    });
    const amount = extractMoney(text);
    const resolved = resolveChargeWhen(text, input.timezone);
    if (!resolved) {
      await writePending(db, input.userId, {
        kind: "charge",
        step: "ask_day",
        name,
        amount,
        fireAtIso: "",
        whenLabel: "",
        body: "",
        timezone: input.timezone,
        needsHour: true,
        workspaceId: input.toolCtx.workspaceId,
      });
      return `Até quando eu cobro *${name}*?`;
    }
    return startChargeDelivery(db, input, {
      kind: "charge",
      step: "ask_phone",
      name,
      amount,
      fireAtIso: resolved.fireAtIso,
      whenLabel: resolved.whenLabel,
      body: "",
      timezone: input.timezone,
      needsHour: resolved.needsHour,
      workspaceId: input.toolCtx.workspaceId,
    });
  }

  if (looksLikeAppointmentCreate(text) && mentionsOtherPeople(text)) {
    const args = buildCreateAppointmentArgs(text, input.timezone);
    if (!args) return null;
    const names = extractPeopleNames(text);
    const channel = detectMeetingChannel(text);
    const pendingMeeting: DeskPending = {
      kind: "meeting",
      step: "channel",
      title: args.title,
      startsAtIso: args.starts_at_iso,
      names,
      timezone: input.timezone,
    };
    if (!channel) {
      await writePending(db, input.userId, pendingMeeting);
      const who = names.length ? ` com ${names.join(" e ")}` : "";
      const whenLabel = formatDeskMoment(
        DateTime.fromISO(args.starts_at_iso).setZone(input.timezone)
      );
      return [
        `📅 *${args.title}*${who}`,
        whenLabel,
        "",
        "Vai ser presencial, Google Meet ou telefone?",
      ].join("\n");
    }
    return afterMeetingChannel(db, input, pendingMeeting, channel);
  }

  const change = fold(text);
  if (/\b(remarca|remarcar|desmarca|cancelar a reuniao|cancela a reuniao)\b/.test(change)) {
    const names = extractPeopleNames(text);
    const name = names[0];
    if (!name) return "Com quem? Me diz o nome.";
    const owner = await ownerFirstName(db, input.userId);
    const cancel = /\b(desmarca|cancelar a reuniao|cancela a reuniao)\b/.test(change);
    if (cancel) {
      const body = `Oi, ${name}. ${owner} pediu para avisar que a reunião foi cancelada.`;
      await writePending(db, input.userId, {
        kind: "meeting",
        step: "confirm_text",
        title: `Reunião com ${name}`,
        startsAtIso: new Date().toISOString(),
        names: [name],
        timezone: input.timezone,
        whenLabel: "agora",
        body,
      });
      return [`Vou avisar *${name}* assim:`, "", body, "", "Mando assim? *sim*, ou escreva o texto."].join("\n");
    }
    const when = parseNaturalDateTime(text, input.timezone);
    if (!when?.isValid) return `Para quando eu remarco com *${name}*?`;
    const whenLabel = formatDeskMoment(when);
    const body = `Oi, ${name}. ${owner} pediu para avisar que a reunião passou para ${whenLabel}.`;
    await writePending(db, input.userId, {
      kind: "meeting",
      step: "confirm_text",
      title: `Reunião com ${name}`,
      startsAtIso: when.toUTC().toISO() || "",
      names: [name],
      timezone: input.timezone,
      whenLabel,
      body,
    });
    return [`Vou avisar *${name}* assim:`, "", body, "", "Mando assim? *sim*, ou escreva o texto."].join("\n");
  }

  return null;
}

async function afterMeetingChannel(
  db: Db,
  input: { userId: string; toolCtx: ToolContext },
  pending: Extract<DeskPending, { kind: "meeting" }>,
  channel: MeetingChannel
): Promise<string> {
  const whenLabel = formatDeskMoment(
    DateTime.fromISO(pending.startsAtIso).setZone(pending.timezone)
  );
  const place =
    channel === "meet" ? "Google Meet" : channel === "telefone" ? "telefone" : "presencial";
  if (!pending.names.length) {
    const created = await finishMeeting(db, input, { ...pending, channel }, false);
    return created;
  }
  await writePending(db, input.userId, {
    ...pending,
    step: "ask_notify",
    channel,
    whenLabel,
  });
  const who = pending.names.join(" e ");
  return [
    `Anoto *${pending.title}* em ${whenLabel}, ${place}.`,
    "",
    `Quer que eu avise *${who}* também?`,
    "Responda *sim* ou *não*.",
  ].join("\n");
}

async function continueNotice(
  db: Db,
  input: { userId: string; text: string; toolCtx: ToolContext },
  pending: DeskPending
): Promise<string> {
  const text = input.text.trim();
  const { looksLikeUndo, looksLikeValueFix } = await import("@/domain/receipt-undo");
  if (pending.kind === "charge" && pending.step === "ask_day") {
    const resolved = resolveChargeWhen(text, pending.timezone);
    if (!resolved) {
      return pending.purpose === "talk"
        ? `Que dia eu te lembro de falar com *${pending.name}*?`
        : `Até quando eu cobro *${pending.name}*?`;
    }
    const next = {
      ...pending,
      fireAtIso: resolved.fireAtIso,
      whenLabel: resolved.whenLabel,
      needsHour: resolved.needsHour,
      workspaceId: pending.workspaceId || input.toolCtx.workspaceId,
    };
    if (pending.purpose === "talk") {
      await writePending(db, input.userId, { ...next, step: "ask_notify" });
      return [
        `Falar com *${pending.name}*, ${resolved.whenLabel}.`,
        "",
        `Quer que eu avise *${pending.name}* também?`,
        "Responda *sim* ou *não*.",
      ].join("\n");
    }
    return startChargeDelivery(db, input, next);
  }
  if (looksLikeUndo(text)) {
    await writePending(db, input.userId, null);
    const name = pending.kind === "charge" ? pending.name : pending.names[0] || "a pessoa";
    return `Desfiz. Não vou avisar *${name}*.`;
  }
  if (pending.kind === "charge") {
    const fix = looksLikeValueFix(text);
    if (fix) {
      const shown = formatDeskMoney(String(fix.amount));
      const next = { ...pending, amount: shown };
      if (pending.purpose === "talk") {
        if (pending.step === "confirm_text") return showDraft(db, input.userId, next);
        await writePending(db, input.userId, next);
        const money = shown ? ` de ${shown}` : "";
        return [
          `*${pending.name}*${money}, até ${pending.whenLabel}.`,
          "",
          `Quer que eu avise *${pending.name}* também?`,
          "Responda *sim* ou *não*.",
        ].join("\n");
      }
      return startChargeDelivery(db, input, next);
    }
  }
  if (pending.step === "ask_notify") {
    if (no(text)) {
      if (pending.kind === "charge") {
        await remindOwner(input, pending);
        await writePending(db, input.userId, null);
        const tail =
          pending.purpose === "talk"
            ? `falar com *${pending.name}*`
            : "cobrar";
        return `Beleza. Não vou falar com *${pending.name}*. Te lembro ${pending.whenLabel} para você ${tail}.`;
      }
      const created = await finishMeeting(db, input, pending, false);
      return `Não vou avisar ninguém.\n${created}`;
    }
    if (!yes(text)) return "Responda *sim* para eu avisar, ou *não* para ficar só com você.";
    if (pending.kind === "charge" && pending.purpose !== "talk") {
      return startChargeDelivery(db, input, pending);
    }
    return askPhoneOrDraft(db, input.userId, pending);
  }

  if (pending.step === "confirm_card") {
    const name = pending.kind === "charge" ? pending.name : pending.names[0] || "";
    if (no(text)) {
      await writePending(db, input.userId, { ...pending, step: "ask_phone", pendingPhone: undefined, cardName: undefined });
      return `Então manda o número ou o contato de *${name}*.`;
    }
    if (!yes(text) || !pending.pendingPhone) {
      return `Uso esse número para avisar *${name}*?`;
    }
    const { upsertFamilyContact } = await import("@/domain/family-contacts");
    await upsertFamilyContact(db, input.userId, {
      name,
      phone: pending.pendingPhone,
      via: "typed",
    });
    return afterPhoneSaved(db, input.userId, pending);
  }

  if (pending.step === "ask_phone") {
    const { normalizePhoneE164 } = await import("@/domain/whatsapp-identities");
    const { upsertFamilyContact } = await import("@/domain/family-contacts");
    const raw = text.match(/(\+?\d[\d\s().-]{8,}\d)/);
    const phone = raw ? normalizePhoneE164(raw[1]) : null;
    const name = pending.kind === "charge" ? pending.name : pending.names[0] || "";
    if (!phone) {
      return `Para avisar *${name}*, manda o número com DDD. Ex.: 61 99999-0000.`;
    }
    await upsertFamilyContact(db, input.userId, { name, phone, via: "typed" });
    return afterPhoneSaved(db, input.userId, pending);
  }

  if (pending.step === "ask_time" && pending.kind === "charge") {
    const timed = clockOnDay(pending.fireAtIso, pending.timezone, text);
    if (!timed) return askNotifyHour(pending.name, pending.whenLabel);
    const next = { ...pending, fireAtIso: timed, needsHour: false };
    if (pending.purpose === "talk") return showDraft(db, input.userId, next);
    return startChargeDelivery(db, input, next);
  }

  if (no(text)) {
    await writePending(db, input.userId, null);
    return "Não mando. O texto foi descartado.";
  }
  if (yes(text)) return sendDraft(db, input, pending);
  const tone = looksLikeToneRewrite(text);
  if (tone && pending.body) {
    const body = rewriteNotice(pending.body, tone);
    const next = { ...pending, step: "confirm_text" as const, body };
    await writePending(db, input.userId, next);
    const name = pending.kind === "charge" ? pending.name : pending.names.join(" e ");
    return [
      `Ficou assim para *${name}*:`,
      "",
      body,
      "",
      "Mando assim? *sim*, ou escreva o texto.",
    ].join("\n");
  }
  const rewritten = text.slice(0, 400);
  const next = { ...pending, step: "confirm_text" as const, body: rewritten };
  await writePending(db, input.userId, next);
  return ["Ficou assim:", "", rewritten, "", "Mando assim? *sim*, ou escreva o texto."].join("\n");
}

async function startChargeDelivery(
  db: Db,
  input: { userId: string; toolCtx: ToolContext },
  pending: Extract<DeskPending, { kind: "charge" }>
): Promise<string> {
  const owner = await ownerFirstName(db, input.userId);
  const body =
    pending.purpose === "talk"
      ? buildTalkNotice(owner, pending.name, pending.whenLabel)
      : buildChargeNotice(owner, pending.name, pending.amount, pending.whenLabel);
  const next = {
    ...pending,
    body,
    workspaceId: pending.workspaceId || input.toolCtx.workspaceId,
    needsHour: pending.whenLabel === "agora" ? false : pending.needsHour,
  };
  if (chargeNeedsHour(next)) {
    await writePending(db, input.userId, { ...next, step: "ask_time" });
    return askNotifyHour(next.name, next.whenLabel);
  }
  return askPhoneOrSendCharge(db, input, next);
}

async function askPhoneOrSendCharge(
  db: Db,
  input: { userId: string; toolCtx?: ToolContext },
  pending: Extract<DeskPending, { kind: "charge" }>
): Promise<string> {
  const { listFamilyContacts, findContactByName } = await import("@/domain/family-contacts");
  const contacts = await listFamilyContacts(db, input.userId);
  const known = findContactByName(contacts, pending.name);
  if (!known) {
    await writePending(db, input.userId, { ...pending, step: "ask_phone" });
    return [
      `*${pending.name}* ainda não está nos contatos.`,
      "Manda o número com DDD, ou o contato.",
    ].join("\n");
  }
  return dispatchChargeNotice(db, input.userId, pending, input.toolCtx);
}

async function dispatchChargeNotice(
  db: Db,
  userId: string,
  pending: Extract<DeskPending, { kind: "charge" }>,
  toolCtx?: ToolContext
): Promise<string> {
  const { sendDeskNoticeToContacts } = await import("@/domain/external-notice");
  const owner = await ownerFirstName(db, userId);
  const workspaceId = pending.workspaceId || toolCtx?.workspaceId;
  if (!workspaceId) {
    await writePending(db, userId, { ...pending, step: "ask_phone" });
    return `Manda o número com DDD de *${pending.name}*.`;
  }
  const fireAt = new Date(pending.fireAtIso || Date.now());
  const sent = await sendDeskNoticeToContacts(db, {
    ownerUserId: userId,
    ownerWorkspaceId: workspaceId,
    ownerName: owner,
    names: [pending.name],
    body:
      pending.body ||
      buildChargeNotice(owner, pending.name, pending.amount, pending.whenLabel),
    fireAt: Number.isNaN(fireAt.getTime()) ? new Date() : fireAt,
    timezone: pending.timezone,
    kind: "charge",
    whenLabel: pending.whenLabel,
  });
  if (toolCtx && pending.whenLabel !== "agora") {
    await remindOwner({ toolCtx }, pending);
  }
  await writePending(db, userId, null);
  return sent;
}

async function askPhoneOrDraft(db: Db, userId: string, pending: DeskPending): Promise<string> {
  const { listFamilyContacts, findContactByName } = await import("@/domain/family-contacts");
  const name = pending.kind === "charge" ? pending.name : pending.names[0] || "";
  const contacts = await listFamilyContacts(db, userId);
  const known = findContactByName(contacts, name);
  if (!known) {
    await writePending(db, userId, { ...pending, step: "ask_phone" });
    return [
      `*${name}* ainda não está nos contatos.`,
      "Manda o número com DDD, ou o contato.",
    ].join("\n");
  }
  return showDraft(db, userId, pending);
}

async function showDraft(db: Db, userId: string, pending: DeskPending): Promise<string> {
  const owner = await ownerFirstName(db, userId);
  const body =
    pending.kind === "charge"
      ? pending.purpose === "talk"
        ? buildTalkNotice(owner, pending.name, pending.whenLabel)
        : buildChargeNotice(owner, pending.name, pending.amount, pending.whenLabel)
      : buildMeetingNotice(
          owner,
          pending.names[0] || "você",
          pending.whenLabel || "",
          pending.channel
        );
  await writePending(db, userId, { ...pending, step: "confirm_text", body });
  const name = pending.kind === "charge" ? pending.name : pending.names.join(" e ");
  return [
    `Vou avisar *${name}* assim:`,
    "",
    body,
    "",
    "Mando assim? *sim*, ou escreva o texto.",
  ].join("\n");
}

async function remindOwner(
  input: { toolCtx: ToolContext },
  pending: Extract<DeskPending, { kind: "charge" }>
): Promise<void> {
  const tool = getTool("create_reminder");
  if (!tool) return;
  const money = pending.amount ? ` ${pending.amount}` : "";
  await tool.handler(input.toolCtx, {
    title: pending.purpose === "talk" ? `Falar com ${pending.name}` : `Cobrar ${pending.name}${money}`,
    fire_at_iso: pending.fireAtIso,
    timezone: pending.timezone,
  });
}

async function sendDraft(
  db: Db,
  input: { userId: string; toolCtx: ToolContext },
  pending: DeskPending
): Promise<string> {
  const { sendDeskNoticeToContacts } = await import("@/domain/external-notice");
  if (pending.kind === "meeting") {
    await finishMeeting(db, input, pending, false);
  }
  const names = pending.kind === "charge" ? [pending.name] : pending.names;
  const fireAt = new Date(pending.kind === "charge" ? pending.fireAtIso : pending.startsAtIso);
  const owner = await ownerFirstName(db, input.userId);
  const whenLabel =
    pending.kind === "charge"
      ? pending.whenLabel
      : pending.whenLabel || "";
  const sent = await sendDeskNoticeToContacts(db, {
    ownerUserId: input.userId,
    ownerWorkspaceId: input.toolCtx.workspaceId,
    ownerName: owner,
    names,
    body: pending.body || "",
    fireAt: Number.isNaN(fireAt.getTime()) ? new Date() : fireAt,
    timezone: pending.timezone,
    kind: pending.kind === "charge" ? "charge" : "meeting_notice",
    whenLabel,
  });
  if (pending.kind === "charge") await remindOwner(input, pending);
  await writePending(db, input.userId, null);
  const mine = pending.kind === "charge" ? "\nTambém te lembro nesse dia." : "";
  return `${sent}${mine}`;
}

async function finishMeeting(
  db: Db,
  input: { userId: string; toolCtx: ToolContext },
  pending: Extract<DeskPending, { kind: "meeting" }>,
  notify: boolean
): Promise<string> {
  const tool = getTool("create_appointment");
  if (!tool) {
    await writePending(db, input.userId, null);
    return "Não consegui gravar a reunião agora.";
  }
  const result = await tool.handler(input.toolCtx, {
    title: pending.title,
    starts_at_iso: pending.startsAtIso,
    timezone: pending.timezone,
    create_meet: pending.channel === "meet",
    also_notify: notify ? pending.names : [],
    reminder_before_minutes: 30,
  });
  if (!notify) await writePending(db, input.userId, null);
  const place =
    pending.channel === "meet"
      ? "Google Meet"
      : pending.channel === "telefone"
        ? "telefone"
        : pending.channel === "presencial"
          ? "presencial"
          : "";
  return place ? `${result.summary}\nLugar: *${place}*.` : result.summary;
}
