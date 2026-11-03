import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";
import {
  formatHoroscope,
  isSignId,
  parseSign,
  signChoiceBlock,
  signLabel,
  type SignId,
} from "@/domain/horoscope";

export type HoroscopePrefs = {
  enabled: boolean;
  sign: SignId | null;
  hour: number;
  minute: number;
  pending: null | "ask_sign" | "ask_daily" | "ask_time";
};

const DEFAULTS: HoroscopePrefs = {
  enabled: false,
  sign: null,
  hour: 8,
  minute: 0,
  pending: null,
};

function norm(text: string): string {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseClock(t: string): { hour: number; minute: number } | null {
  const m =
    t.match(/\b(\d{1,2})\s*[:h]\s*(\d{2})\b/) ||
    t.match(/\b(\d{1,2})\s*h\b/) ||
    t.match(/\bas\s+(\d{1,2})\b/) ||
    t.match(/\ba\s+(\d{1,2})\b/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] != null ? Number(m[2]) : 0;
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function clockLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function mentionsHoroscope(t: string): boolean {
  return /horoscop|signo|zodiaco/.test(t);
}

function wantsOff(t: string): boolean {
  return /(desliga|desativar|parar|para de|nao quero|cancela)/.test(t) &&
    mentionsHoroscope(t);
}

export function looksLikeHoroscopeTurn(text: string, prefs?: HoroscopePrefs): boolean {
  const t = norm(text);
  if (!t || t.length > 160) return false;
  if (prefs?.pending) {
    if (/\b(lembra|lembrar|lembrete|agenda|compromisso)\b/.test(t)) return false;
    if (mentionsHoroscope(t) || parseSign(t) || parseClock(t)) return true;
    if (/^(sim|nao|ok|pode|quero|cancela|para)$/.test(t)) return true;
    return t.split(" ").length <= 2;
  }
  if (mentionsHoroscope(t)) return true;
  if (parseSign(t) && t.split(" ").length <= 3) return true;
  return false;
}

function parseStored(profileJson: Record<string, unknown> | null | undefined): HoroscopePrefs {
  const h = (profileJson?.horoscope || {}) as Record<string, unknown>;
  const sign = typeof h.sign === "string" && isSignId(h.sign) ? h.sign : null;
  const hour =
    typeof h.hour === "number" && h.hour >= 0 && h.hour <= 23 ? h.hour : 8;
  const minute =
    typeof h.minute === "number" && h.minute >= 0 && h.minute <= 59
      ? h.minute
      : 0;
  const pending =
    h.pending === "ask_sign" || h.pending === "ask_daily" || h.pending === "ask_time"
      ? h.pending
      : null;
  return {
    enabled: h.enabled === true && Boolean(sign),
    sign,
    hour,
    minute,
    pending,
  };
}

export async function shouldHandleHoroscopeTurn(
  db: Db,
  userId: string,
  text: string
): Promise<boolean> {
  const prefs = await getHoroscopePrefs(db, userId);
  return looksLikeHoroscopeTurn(text, prefs);
}

export async function getHoroscopePrefs(db: Db, userId: string): Promise<HoroscopePrefs> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return parseStored((user?.profileJson || {}) as Record<string, unknown>);
}

async function saveHoroscopePrefs(
  db: Db,
  userId: string,
  next: HoroscopePrefs
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("user_not_found");
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
    horoscope: next,
  };
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export function horoscopeDueNow(
  prefs: HoroscopePrefs,
  hour: number,
  minute: number
): boolean {
  if (!prefs.enabled || !prefs.sign) return false;
  if (prefs.hour !== hour) return false;
  return minute >= prefs.minute && minute < prefs.minute + 15;
}

export async function handleHoroscopeTurn(
  db: Db,
  userId: string,
  text: string
): Promise<string> {
  const t = norm(text);
  const prefs = await getHoroscopePrefs(db, userId);

  if (wantsOff(t) || (prefs.pending && /^(nao|não|cancela|para)$/.test(t) && prefs.pending !== "ask_sign")) {
    await saveHoroscopePrefs(db, userId, {
      ...prefs,
      enabled: false,
      pending: null,
    });
    return "Pronto. O horóscopo do dia fica desligado. Quando quiser de novo: “horóscopo”.";
  }

  if (prefs.pending === "ask_sign") {
    const sign = parseSign(t);
    if (!sign) {
      return signChoiceBlock("Não reconheci o signo. Escolhe um:");
    }
    const next = { ...prefs, sign, pending: "ask_daily" as const, enabled: false };
    await saveHoroscopePrefs(db, userId, next);
    return [
      formatHoroscope(sign),
      "",
      "Quer receber isso *todo dia*? Se sim, me diz o horário. Se não, responde *não*.",
    ].join("\n");
  }

  if (prefs.pending === "ask_daily" || prefs.pending === "ask_time") {
    const clock = parseClock(t);
    const yes = /^(sim|quero|pode|ok|bora|todo dia)\b/.test(t) || Boolean(clock);
    if (!yes || /^(nao|não)\b/.test(t)) {
      await saveHoroscopePrefs(db, userId, { ...prefs, enabled: false, pending: null });
      return prefs.sign
        ? `Beleza. Sem aviso todo dia. Quando quiser de novo: “horóscopo de ${signLabel(prefs.sign)}”.`
        : "Beleza. Sem aviso todo dia.";
    }
    if (!clock) {
      await saveHoroscopePrefs(db, userId, { ...prefs, pending: "ask_time" });
      return "Qual horário? Ex.: *8h* ou *7:30*.";
    }
    if (!prefs.sign) {
      await saveHoroscopePrefs(db, userId, { ...prefs, pending: "ask_sign" });
      return signChoiceBlock("Antes, qual é o seu signo?");
    }
    await saveHoroscopePrefs(db, userId, {
      ...prefs,
      enabled: true,
      hour: clock.hour,
      minute: clock.minute,
      pending: null,
    });
    return `Combinado. Todo dia às *${clockLabel(clock.hour, clock.minute)}* eu mando o horóscopo de ${signLabel(prefs.sign)}. Para parar: “desliga horóscopo”.`;
  }

  const named = parseSign(t);
  const clock = parseClock(t);
  const daily = /todo dia|todos os dias|diari/.test(t);

  if (named && (daily || clock)) {
    const hour = clock?.hour ?? prefs.hour;
    const minute = clock?.minute ?? 0;
    await saveHoroscopePrefs(db, userId, {
      enabled: true,
      sign: named,
      hour,
      minute,
      pending: null,
    });
    return [
      formatHoroscope(named),
      "",
      `Vou mandar todo dia às *${clockLabel(hour, minute)}*. Para parar: “desliga horóscopo”.`,
    ].join("\n");
  }

  if (named && !prefs.sign) {
    await saveHoroscopePrefs(db, userId, {
      ...prefs,
      sign: named,
      pending: "ask_daily",
      enabled: false,
    });
    return [
      formatHoroscope(named),
      "",
      "Quer receber isso *todo dia*? Se sim, me diz o horário. Se não, responde *não*.",
    ].join("\n");
  }

  const sign = named || prefs.sign;
  if (!sign) {
    await saveHoroscopePrefs(db, userId, { ...prefs, pending: "ask_sign" });
    return signChoiceBlock("Qual é o seu signo?");
  }

  if (daily && !clock) {
    await saveHoroscopePrefs(db, userId, { ...prefs, sign, pending: "ask_time" });
    return "Qual horário você quer receber? Ex.: *8h*.";
  }

  const status = prefs.enabled
    ? `Aviso do dia ligado às ${clockLabel(prefs.hour, prefs.minute)}.`
    : "Aviso do dia desligado. Se quiser todo dia, manda o horário. Ex.: *horóscopo às 8h*.";
  return [formatHoroscope(sign), "", status].join("\n");
}
