/**
 * “Saí de casa?” — próximo compromisso + rota → horário de saída.
 */
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { appointments } from "@/db/schema";
import {
  handleRouteTurn,
  looksLikeRouteIntent,
  parseRouteDestination,
} from "@/domain/routes";

const BUFFER_MIN = 15;

function norm(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function looksLikeLeaveHomeIntent(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 180) return false;
  if (
    /(quando sair|que horas sair|horario de saida|sai de casa|sair de casa|hora de sair|quando eu saio|quando tenho que sair|me avisa pra sair)/.test(
      t
    )
  ) {
    return true;
  }
  if (/^(sair|saida)\b/.test(t) && /(compromisso|agenda|reuniao|dentista)/.test(t)) {
    return true;
  }
  return false;
}

async function nextAppointment(
  db: Db,
  input: { workspaceId: string; userId: string; timezone: string }
) {
  const now = DateTime.now().setZone(input.timezone);
  const until = now.plus({ hours: 36 });
  const rows = await db.query.appointments.findMany({
    where: and(
      eq(appointments.workspaceId, input.workspaceId),
      eq(appointments.status, "scheduled"),
      isNull(appointments.deletedAt),
      gte(appointments.startsAt, now.toJSDate()),
      lte(appointments.startsAt, until.toJSDate())
    ),
    orderBy: (a, { asc }) => [asc(a.startsAt)],
    limit: 5,
  });
  return (
    rows.find((a) => !a.userId || a.userId === input.userId) || rows[0] || null
  );
}

export async function handleLeaveHomeTurn(
  db: Db,
  input: {
    userId: string;
    workspaceId: string;
    text: string;
    phoneE164?: string | null;
    timezone?: string;
  }
): Promise<string> {
  const tz = input.timezone || "America/Sao_Paulo";
  const destOverride = parseRouteDestination(input.text);
  const appt = await nextAppointment(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    timezone: tz,
  });

  if (!appt && !destOverride) {
    return [
      "🚪 *Saí de casa*",
      "",
      "Não achei compromisso nas próximas 36h.",
      "Marque um (ex.: *reunião amanhã às 15h no aeroporto*) ou diga:",
      "• *quando sair pro aeroporto*",
      "• *quanto tempo até o aeroporto* (rota pura)",
    ].join("\n");
  }

  const dest =
    destOverride ||
    (appt?.location && String(appt.location).trim()) ||
    (appt ? String(appt.title).replace(/^compromisso:\s*/i, "") : null);

  if (!dest) {
    return [
      "🚪 Próximo compromisso:",
      `📅 *${appt!.title}* às ${DateTime.fromJSDate(appt!.startsAt)
        .setZone(tz)
        .toFormat("HH:mm")}`,
      "",
      "Cadê o local? Ex.: *quando sair pro aeroporto* ou salve o local no compromisso.",
    ].join("\n");
  }

  // Reusa o motor de rotas (pede pin se precisar)
  const routeText = `quanto tempo até ${dest}`;
  const routeReply = await handleRouteTurn(db, {
    userId: input.userId,
    text: routeText,
    phoneE164: input.phoneE164,
  });

  // Se pediu pin, devolve como está (já tem pending_dest do route)
  if (/Cadê você|Localização atual|pin/i.test(routeReply)) {
    return [
      "🚪 *Saí de casa*",
      appt
        ? `Próximo: *${appt.title}* às ${DateTime.fromJSDate(appt.startsAt)
            .setZone(tz)
            .toFormat("HH:mm")}`
        : `Destino: *${dest}*`,
      "",
      routeReply,
    ].join("\n");
  }

  // Extrai minutos do card de rota
  const m = routeReply.match(/\*(\d+)\s*min\*/i) || routeReply.match(/(\d+)\s*min/);
  const hMatch = routeReply.match(/\*(\d+)\s*h(?:\s*(\d+)\s*min)?\*/i);
  let travelMin = m ? Number(m[1]) : null;
  if (hMatch) {
    travelMin = Number(hMatch[1]) * 60 + (hMatch[2] ? Number(hMatch[2]) : 0);
  }

  if (!appt || travelMin == null || !Number.isFinite(travelMin)) {
    return [
      "🚪 *Saí de casa*",
      "",
      routeReply,
      "",
      "_Com compromisso na agenda eu também calculo *que horas sair*._",
    ].join("\n");
  }

  const start = DateTime.fromJSDate(appt.startsAt).setZone(tz);
  const leaveAt = start.minus({ minutes: travelMin + BUFFER_MIN });
  const now = DateTime.now().setZone(tz);
  const alreadyLate = leaveAt < now;

  return [
    "🚪 *Saí de casa*",
    "────────────",
    `📅 *${appt.title}*`,
    `🕐 Compromisso: ${start.toFormat("HH:mm")}`,
    `🏁 Destino: ${dest}`,
    `🚗 Trajeto ~${travelMin} min + ${BUFFER_MIN} min de folga`,
    "",
    alreadyLate
      ? `🔴 *Saia agora* — o ideal era ${leaveAt.toFormat("HH:mm")}`
      : `🟢 *Saia às ${leaveAt.toFormat("HH:mm")}*`,
    "",
    routeReply.replace(/^🛣️ \*Bora!\*\n────────────\n/, ""),
  ].join("\n");
}

/** Também trata atalhos mistos com rota pura. */
export function shouldHandleLeaveOrRoute(text: string): boolean {
  return looksLikeLeaveHomeIntent(text) || looksLikeRouteIntent(text);
}
