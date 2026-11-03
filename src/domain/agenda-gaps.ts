/**
 * Buracos da manhã e choques de horário. O painel só nasce com 4+ livres ou 2+ choques.
 */
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { parseNaturalDateTime } from "@/lib/datetime";
import { loadDayAgenda } from "@/domain/day-agenda";
import { appendVisualBoard, type VisualBoardPayload } from "@/domain/visual-board";

const WEEKDAYS = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

export type HourHole = {
  day: string;
  hour: string;
  state: "livre" | "ocupado";
  title?: string;
};

export type AgendaClash = {
  day: string;
  hour: string;
  titles: string[];
};

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function deskDay(dt: DateTime): string {
  const name = WEEKDAYS[dt.weekday] || dt.setLocale("pt-BR").toFormat("cccc");
  return `${name} ${dt.toFormat("dd/LL")}`;
}

function deskClock(dt: DateTime): string {
  if (dt.minute === 0) return `${dt.hour}h`;
  return `${dt.hour}h${String(dt.minute).padStart(2, "0")}`;
}

export function looksLikeFreeSlotAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  if (/\b(marcar|agendar|marque|anotar|anota|compromisso|falar com|ligar)\b/.test(t)) {
    return false;
  }
  if (/\blivre via\b/.test(t)) return false;
  return (
    (/\bhorarios?\s+livres?\b/.test(t) ||
      /\b(manha|tarde|noite)\s+livre\b/.test(t) ||
      /\blivre\s+(de\s+)?(manha|tarde|noite|hoje|amanha)\b/.test(t) ||
      /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta)\s+\w*\s*livre\??$/.test(t)) &&
    /\b(manha|tarde|noite|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|horarios?)\b/.test(
      t
    )
  );
}

export function looksLikeClashAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  return /\bchoque\b/.test(t);
}

export function slotWindow(text: string): { startHour: number; endHour: number; label: string } {
  const t = fold(text);
  if (/\btarde\b/.test(t)) return { startHour: 13, endHour: 18, label: "de tarde" };
  if (/\bnoite\b/.test(t)) return { startHour: 18, endHour: 21, label: "de noite" };
  return { startHour: 8, endHour: 12, label: "de manhã" };
}

export function hourHoles(
  day: DateTime,
  startHour: number,
  endHour: number,
  busy: Array<{ at: Date; title: string }>
): HourHole[] {
  const zone = day.zoneName || "America/Sao_Paulo";
  const holes: HourHole[] = [];
  for (let hour = startHour; hour < endHour; hour += 1) {
    const hit = busy.find((item) => {
      const at = DateTime.fromJSDate(item.at).setZone(zone);
      return at.hasSame(day, "day") && at.hour === hour;
    });
    holes.push({
      day: deskDay(day),
      hour: `${hour}h`,
      state: hit ? "ocupado" : "livre",
      title: hit?.title,
    });
  }
  return holes;
}

export function findClashes(
  items: Array<{ at: Date; title: string; zone: string }>
): AgendaClash[] {
  const groups = new Map<string, AgendaClash & { sort: number }>();
  for (const item of items) {
    const at = DateTime.fromJSDate(item.at).setZone(item.zone || "America/Sao_Paulo");
    if (!at.isValid) continue;
    const key = at.toFormat("yyyy-LL-dd HH");
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        day: deskDay(at),
        hour: `${at.hour}h`,
        titles: [item.title],
        sort: at.toMillis(),
      });
      continue;
    }
    if (!current.titles.includes(item.title)) current.titles.push(item.title);
  }
  return [...groups.values()]
    .filter((group) => group.titles.length >= 2)
    .sort((a, b) => a.sort - b.sort)
    .map(({ day, hour, titles }) => ({ day, hour, titles }));
}

function boardForHoles(title: string, holes: HourHole[]): VisualBoardPayload {
  const livres = holes.filter((hole) => hole.state === "livre").length;
  return {
    kind: "pessoal",
    title,
    kpis: [
      { label: "Livres", value: String(livres), tone: "ok" },
      { label: "Ocupados", value: String(holes.length - livres), tone: "warn" },
    ],
    bars: [],
    rows: [],
    alerts: [],
    table: {
      search: "horário",
      title: "Horários",
      layout: "cards",
      columns: [
        { key: "nome", label: "Dia · hora" },
        { key: "situacao", label: "Situação" },
      ],
      rows: holes.map((hole) => ({
        cells: {
          nome: `${hole.day} · ${hole.hour}`,
          situacao: hole.state === "livre" ? "livre" : `ocupado${hole.title ? ` · ${hole.title}` : ""}`,
        },
      })),
    },
  };
}

function boardForClashes(clashes: AgendaClash[]): VisualBoardPayload {
  return {
    kind: "pessoal",
    title: "Choques na agenda",
    kpis: [{ label: "Choques", value: String(clashes.length), tone: "warn" }],
    bars: [],
    rows: [],
    alerts: [],
    table: {
      search: "horário",
      title: "Horários",
      layout: "cards",
      columns: [
        { key: "nome", label: "Dia · hora" },
        { key: "situacao", label: "Situação" },
      ],
      rows: clashes.map((clash) => ({
        cells: {
          nome: `${clash.day} · ${clash.hour}`,
          situacao: `ocupado · ${clash.titles.join(" e ")}`,
        },
      })),
    },
  };
}

export async function answerAgendaGap(
  db: Db,
  input: { workspaceId: string; userId: string; text: string; timezone: string }
): Promise<string | null> {
  const zone = input.timezone || "America/Sao_Paulo";
  if (looksLikeFreeSlotAsk(input.text)) {
    const when = parseNaturalDateTime(input.text, zone);
    if (!when?.isValid) return "Qual dia? Pode ser sexta, ou amanhã.";
    const window = slotWindow(input.text);
    const dayIso = when.toISODate() || "";
    const items = await loadDayAgenda(db, input.workspaceId, zone, dayIso);
    const holes = hourHoles(when, window.startHour, window.endHour, items.map((item) => ({
      at: item.at,
      title: item.title,
    })));
    const livres = holes.filter((hole) => hole.state === "livre");
    const day = deskDay(when);
    if (livres.length >= 4) {
      const summary = `*${day}* ${window.label}: *${livres.length}* horários livres.`;
      return appendVisualBoard(
        { db, workspaceId: input.workspaceId, userId: input.userId },
        summary,
        boardForHoles(`${day} ${window.label}`, holes)
      );
    }
    const lines = holes.map((hole) =>
      hole.state === "livre" ? `*${hole.hour}* livre` : `*${hole.hour}* ocupado${hole.title ? ` · ${hole.title}` : ""}`
    );
    return [`*${day}* ${window.label}`, ...lines].join("\n");
  }

  if (looksLikeClashAsk(input.text)) {
    const start = DateTime.now().setZone(zone).startOf("day");
    const items: Array<{ at: Date; title: string; zone: string }> = [];
    for (let i = 0; i < 14; i += 1) {
      const day = start.plus({ days: i });
      const rows = await loadDayAgenda(db, input.workspaceId, zone, day.toISODate() || "");
      for (const row of rows) items.push({ at: row.at, title: row.title, zone });
    }
    const clashes = findClashes(items);
    if (!clashes.length) return "Nos próximos 14 dias não tem dois compromissos no mesmo horário.";
    if (clashes.length >= 2) {
      const summary = `Achei *${clashes.length}* choques nos próximos 14 dias.`;
      return appendVisualBoard(
        { db, workspaceId: input.workspaceId, userId: input.userId },
        summary,
        boardForClashes(clashes)
      );
    }
    const one = clashes[0];
    return `*${one.day} · ${one.hour}* — *${one.titles.join("* e *")}* no mesmo horário.`;
  }

  return null;
}
