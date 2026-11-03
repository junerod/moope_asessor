/**
 * Ata só com o que a pessoa mandou. Não inventa ata do Meet.
 */
import type { Db } from "@/db/client";
import { memories } from "@/db/schema";
import { appendVisualBoard } from "@/domain/visual-board";

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function looksLikeAtaAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 160) return false;
  return /\b(faz a ata|faz uma ata|ata da reuniao|anota a ata|grava a ata)\b/.test(t);
}

export function extractAtaBody(text: string): string | null {
  const raw = String(text || "").trim();
  const stripped = raw
    .replace(/^(faz a ata|faz uma ata|ata da reuniao|anota a ata|grava a ata)[:\s-]*/i, "")
    .trim();
  if (!stripped || fold(stripped) === fold(raw)) {
    const after = raw.split(/ata[:\s-]+/i)[1];
    const body = String(after || "").trim();
    return body.length >= 8 ? body : null;
  }
  return stripped.length >= 8 ? stripped : null;
}

function splitTasks(body: string): Array<{ tarefa: string; quem: string }> {
  const parts = body
    .split(/\n|;|\.(?=\s+[A-ZÀ-Ÿ])/)
    .map((item) => item.replace(/^[-•\d.)\s]+/, "").trim())
    .filter((item) => item.length >= 4);
  return parts.map((tarefa) => {
    const who = tarefa.match(/\b(?:com|pra|para|o|a)\s+([A-ZÀ-Ÿ][a-zà-ÿ]{2,20})\b/);
    return { tarefa: tarefa.slice(0, 80), quem: who?.[1] || "—" };
  });
}

export async function answerMeetingNotes(
  db: Db,
  input: { workspaceId: string; userId: string; text: string }
): Promise<string | null> {
  if (!looksLikeAtaAsk(input.text)) return null;
  const body = extractAtaBody(input.text);
  if (!body) {
    return "O que ficou? Manda o texto ou o áudio da ata.";
  }
  await db.insert(memories).values({
    workspaceId: input.workspaceId,
    createdByUserId: input.userId,
    type: "decision",
    content: body.slice(0, 800),
    sourceType: "meeting_notes",
    status: "active",
    metadata: { kind: "ata" },
  });
  const tasks = splitTasks(body);
  let reply = `Ata anotada.\n${body.slice(0, 280)}`;
  if (tasks.length >= 4) {
    reply = await appendVisualBoard(
      { db, workspaceId: input.workspaceId, userId: input.userId },
      reply,
      {
        kind: "pessoal",
        title: "Ata",
        kpis: [{ label: "Tarefas", value: String(tasks.length) }],
        bars: [],
        rows: [],
        alerts: [],
        table: {
          search: "",
          layout: "cards",
          columns: [
            { key: "nome", label: "Tarefa" },
            { key: "situacao", label: "Quem" },
          ],
          rows: tasks.map((item) => ({
            cells: { nome: item.tarefa, situacao: item.quem },
          })),
        },
        note: "Só o que você mandou. O link vale 24 horas.",
      }
    );
  }
  return reply;
}
