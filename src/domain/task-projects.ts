/**
 * Tarefa com projeto e fila de atraso. Sem pirâmide.
 */
import { and, eq, isNull, lte, ne } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { tasks } from "@/db/schema";
import { formatDeskDay } from "@/domain/desk-router";
import { parseNaturalDateTime } from "@/lib/datetime";

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function looksLikeOverdueAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  return /tarefas atrasadas|o que atrasou|fila de atraso/.test(t);
}

export function looksLikeTaskProject(text: string): {
  title: string;
  project: string;
  dueAt?: DateTime;
} | null {
  const raw = String(text || "").trim();
  const match =
    raw.match(
      /^(?:tarefa do )?projeto\s+([A-Za-zÀ-ÿ0-9]{2,40})\s*[:\-–]\s*(.+)$/i
    ) || raw.match(/^tarefa\s+(.+?)\s+(?:do|no)\s+projeto\s+([A-Za-zÀ-ÿ0-9]{2,40})(.*)$/i);
  if (!match) return null;
  const projectFirst = /^(?:tarefa do )?projeto/i.test(raw);
  const project = (projectFirst ? match[1] : match[2]).trim();
  const rest = (projectFirst ? match[2] : `${match[1]} ${match[3] || ""}`).trim();
  if (!project || rest.length < 2) return null;
  const due = parseNaturalDateTime(rest, "America/Sao_Paulo");
  const title = rest
    .replace(
      /\b(?:ate|até|para|pra)?\s*(?:segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|hoje|amanh[ãa]|dia\s+\d{1,2}).*$/i,
      ""
    )
    .trim() || rest;
  return { title: title.slice(0, 200), project, dueAt: due?.isValid ? due : undefined };
}

export async function answerTaskProjects(
  db: Db,
  input: { workspaceId: string; userId: string; text: string; timezone: string }
): Promise<string | null> {
  if (looksLikeOverdueAsk(input.text)) {
    const now = new Date();
    const rows = await db.query.tasks.findMany({
      where: and(
        eq(tasks.workspaceId, input.workspaceId),
        isNull(tasks.deletedAt),
        ne(tasks.status, "completed"),
        ne(tasks.status, "cancelled"),
        lte(tasks.dueAt, now)
      ),
      limit: 30,
    });
    if (!rows.length) return "Nada atrasado.";
    const tz = input.timezone || "America/Sao_Paulo";
    const lines = rows.slice(0, 8).map((row) => {
      const meta = (row.metadata || {}) as Record<string, unknown>;
      const project = meta.project ? ` · ${meta.project}` : "";
      const due = row.dueAt
        ? formatDeskDay(DateTime.fromJSDate(row.dueAt).setZone(tz))
        : "";
      return `• *${row.title}*${project}${due ? ` · ${due}` : ""}`;
    });
    return [`Atrasadas (${rows.length}):`, ...lines].join("\n");
  }

  const parsed = looksLikeTaskProject(input.text);
  if (!parsed) return null;
  const [row] = await db
    .insert(tasks)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      assignedUserId: input.userId,
      title: parsed.title,
      status: "open",
      dueAt: parsed.dueAt ? parsed.dueAt.toJSDate() : null,
      metadata: { project: parsed.project },
    })
    .returning();
  const due = parsed.dueAt ? ` até ${formatDeskDay(parsed.dueAt)}` : "";
  return `Tarefa *${row.title}* no projeto *${parsed.project}*${due}.`;
}
