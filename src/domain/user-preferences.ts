import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";

export type NotificationPrefs = {
  daily_brief: boolean;
  weekly_digest: boolean;
  goal_alerts: boolean;
  bill_alerts: boolean;
  evening_wrap: boolean;
  /** Hora local (America/Sao_Paulo) do encerramento — default 21 */
  evening_wrap_hour: number;
  evening_wrap_minute: number;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  daily_brief: true,
  weekly_digest: true,
  goal_alerts: true,
  bill_alerts: true,
  evening_wrap: true,
  evening_wrap_hour: 21,
  evening_wrap_minute: 0,
};

export function parsePrefsFromProfile(
  profileJson: Record<string, unknown> | null | undefined
): NotificationPrefs {
  const n = (profileJson?.notifications || {}) as Record<string, unknown>;
  return {
    daily_brief:
      typeof n.daily_brief === "boolean"
        ? n.daily_brief
        : DEFAULT_NOTIFICATION_PREFS.daily_brief,
    weekly_digest:
      typeof n.weekly_digest === "boolean"
        ? n.weekly_digest
        : DEFAULT_NOTIFICATION_PREFS.weekly_digest,
    goal_alerts:
      typeof n.goal_alerts === "boolean"
        ? n.goal_alerts
        : DEFAULT_NOTIFICATION_PREFS.goal_alerts,
    bill_alerts:
      typeof n.bill_alerts === "boolean"
        ? n.bill_alerts
        : DEFAULT_NOTIFICATION_PREFS.bill_alerts,
    evening_wrap:
      typeof n.evening_wrap === "boolean"
        ? n.evening_wrap
        : DEFAULT_NOTIFICATION_PREFS.evening_wrap,
    evening_wrap_hour:
      typeof n.evening_wrap_hour === "number" &&
      n.evening_wrap_hour >= 0 &&
      n.evening_wrap_hour <= 23
        ? n.evening_wrap_hour
        : DEFAULT_NOTIFICATION_PREFS.evening_wrap_hour,
    evening_wrap_minute:
      typeof n.evening_wrap_minute === "number" &&
      n.evening_wrap_minute >= 0 &&
      n.evening_wrap_minute <= 59
        ? n.evening_wrap_minute
        : DEFAULT_NOTIFICATION_PREFS.evening_wrap_minute,
  };
}

export async function getNotificationPrefs(
  db: Db,
  userId: string
): Promise<NotificationPrefs> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return parsePrefsFromProfile(
    (user?.profileJson || {}) as Record<string, unknown>
  );
}

export async function setNotificationPrefs(
  db: Db,
  userId: string,
  patch: Partial<NotificationPrefs>
): Promise<NotificationPrefs> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("user_not_found");
  const current = parsePrefsFromProfile(
    (user.profileJson || {}) as Record<string, unknown>
  );
  const next = { ...current, ...patch };
  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
    notifications: next,
  };
  await db
    .update(users)
    .set({ profileJson: profile, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return next;
}

/** Detecta pedido de preferências (todos os usuários — não só DEV). */
export function looksLikePreferencesCommand(text: string): boolean {
  const t = String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!t || t.length > 120) return false;
  if (/^\/?preferencias?\b/.test(t)) return true;
  if (/^(prefs|configuracoes|config)\b/.test(t)) return true;
  if (/encerra(r|mento)?\s+(o\s+)?dia\s+(as|às|a)/.test(t)) return true;
  if (
    /(liga|desliga|ativar|desativar|quero|nao quero).*(resumo|brief|digest|alerta|encerramento|boa noite)/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

export type PrefsCommand =
  | { action: "show" }
  | { action: "set"; key: keyof NotificationPrefs; value: boolean }
  | {
      action: "set_evening_time";
      hour: number;
      minute: number;
    };

export function parsePreferencesCommand(text: string): PrefsCommand | null {
  if (!looksLikePreferencesCommand(text)) return null;
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  return parsePreferencesCommandInner(t);
}

function parseClockFromPrefsText(
  t: string
): { hour: number; minute: number } | null {
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

function parsePreferencesCommandInner(t: string): PrefsCommand | null {
  if (/encerr/.test(t) && parseClockFromPrefsText(t)) {
    const clock = parseClockFromPrefsText(t)!;
    return { action: "set_evening_time", hour: clock.hour, minute: clock.minute };
  }

  const on = /(liga|ativar|ative|quero receber|liga o)/.test(t);
  const off = /(desliga|desativar|desative|nao quero|para de enviar)/.test(t);

  if (on || off) {
    const value = on && !off;
    if (/resumo do dia|brief|bom dia|resumo diario/.test(t)) {
      return { action: "set", key: "daily_brief", value };
    }
    if (/encerramento|boa noite|fecho do dia|fechamento/.test(t)) {
      return { action: "set", key: "evening_wrap", value };
    }
    if (/resumo semanal|digest|semana/.test(t)) {
      return { action: "set", key: "weekly_digest", value };
    }
    if (/meta|gasto|limite/.test(t)) {
      return { action: "set", key: "goal_alerts", value };
    }
    if (/conta|boleto|vencimento/.test(t)) {
      return { action: "set", key: "bill_alerts", value };
    }
    if (/tudo|todos|todas/.test(t)) {
      return { action: "set", key: "daily_brief", value };
    }
  }

  return { action: "show" };
}

export function formatPreferencesMessage(prefs: NotificationPrefs): string {
  const yn = (v: boolean) => (v ? "✅ ligado" : "⬜ desligado");
  const clock = `${String(prefs.evening_wrap_hour).padStart(2, "0")}:${String(prefs.evening_wrap_minute).padStart(2, "0")}`;
  return [
    "⚙️ *Preferências · Assessor*",
    "────────────",
    `• Resumo do dia (manhã): ${yn(prefs.daily_brief)}`,
    `• Encerramento do dia (${clock}): ${yn(prefs.evening_wrap)}`,
    `• Resumo semanal (domingo): ${yn(prefs.weekly_digest)}`,
    `• Alertas de meta de gastos: ${yn(prefs.goal_alerts)}`,
    `• Alertas de contas a vencer: ${yn(prefs.bill_alerts)}`,
    "────────────",
    "*Como mudar*",
    "• `desliga o resumo do dia`",
    "• `desliga encerramento do dia`",
    "• `encerra o dia às 20h`",
    "• `liga alertas de meta`",
    "",
    "🌤️ *Tempo:* `como está o tempo?` · `me avisa o tempo às 7h`",
    "🚪 *Saí de casa:* `quando sair`",
    "",
    "_Ou diga *preferências* a qualquer momento._",
  ].join("\n");
}

export async function handlePreferencesTurn(
  db: Db,
  userId: string,
  text: string
): Promise<string> {
  const cmd = parsePreferencesCommand(text) || { action: "show" as const };
  const raw = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (cmd.action === "show") {
    const prefs = await getNotificationPrefs(db, userId);
    return formatPreferencesMessage(prefs);
  }

  if (cmd.action === "set_evening_time") {
    const prefs = await setNotificationPrefs(db, userId, {
      evening_wrap: true,
      evening_wrap_hour: cmd.hour,
      evening_wrap_minute: cmd.minute,
    });
    const clock = `${String(cmd.hour).padStart(2, "0")}:${String(cmd.minute).padStart(2, "0")}`;
    return (
      `🌙 Encerramento do dia ligado às *${clock}*.\n\n` +
      formatPreferencesMessage(prefs)
    );
  }

  // “desliga tudo” / “liga tudo”
  if (/(liga|desliga).*(tudo|todos)/.test(raw)) {
    const value = /liga/.test(raw) && !/desliga/.test(raw);
    const prefs = await setNotificationPrefs(db, userId, {
      daily_brief: value,
      weekly_digest: value,
      goal_alerts: value,
      bill_alerts: value,
      evening_wrap: value,
    });
    return (
      (value ? "✅ Liguei *todos* os avisos.\n\n" : "⬜ Desliguei *todos* os avisos.\n\n") +
      formatPreferencesMessage(prefs)
    );
  }

  const prefs = await setNotificationPrefs(db, userId, {
    [cmd.key]: cmd.value,
  });
  const labels: Record<
    "daily_brief" | "weekly_digest" | "goal_alerts" | "bill_alerts" | "evening_wrap",
    string
  > = {
    daily_brief: "resumo do dia",
    weekly_digest: "resumo semanal",
    goal_alerts: "alertas de meta",
    bill_alerts: "alertas de conta",
    evening_wrap: "encerramento do dia",
  };
  if (
    cmd.key === "evening_wrap_hour" ||
    cmd.key === "evening_wrap_minute"
  ) {
    return formatPreferencesMessage(prefs);
  }
  return (
    `${cmd.value ? "✅" : "⬜"} *${labels[cmd.key]}* ${
      cmd.value ? "ligado" : "desligado"
    }.\n\n` + formatPreferencesMessage(prefs)
  );
}
