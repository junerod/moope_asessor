/**
 * Pasta e prazo do documento que a pessoa já mandou. Sem drive novo.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { documents } from "@/db/schema";
import { formatDeskDay } from "@/domain/desk-router";
import { parseNaturalDateTime } from "@/lib/datetime";

function fold(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const FOLDERS = ["contratos", "recibos", "identidade", "receitas", "boletos", "outros"] as const;

export function guessDocFolder(filename: string, caption?: string | null): string {
  const t = fold(`${filename} ${caption || ""}`);
  if (/contrato|aditivo/.test(t)) return "contratos";
  if (/recibo|comprovante/.test(t)) return "recibos";
  if (/\brg\b|cnh|identidade|passaporte/.test(t)) return "identidade";
  if (/receita|receituario|remedio/.test(t)) return "receitas";
  if (/boleto|fatura/.test(t)) return "boletos";
  return "outros";
}

export function looksLikeDocFolderAsk(text: string): boolean {
  const t = fold(text);
  if (!t || t.length > 120) return false;
  if (/guarda na pasta|documentos da pasta|pasta (de )?contratos|pasta recibos/.test(t)) {
    return true;
  }
  if (/esse (contrato|documento|arquivo) vence|prazo (do|deste) documento/.test(t)) {
    return true;
  }
  return /acha (a foto|o documento|o arquivo|a imagem)|foto do (rg|contrato|recibo)/.test(t);
}

function folderFromText(text: string): string | null {
  const t = fold(text);
  for (const name of FOLDERS) {
    if (t.includes(name) || t.includes(name.slice(0, -1))) return name;
  }
  if (/\brg\b|cnh/.test(t)) return "identidade";
  return null;
}

async function latestDoc(db: Db, workspaceId: string) {
  return db.query.documents.findFirst({
    where: and(eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)),
    orderBy: [desc(documents.createdAt)],
  });
}

export async function answerDocFolder(
  db: Db,
  input: { workspaceId: string; text: string; timezone: string }
): Promise<string | null> {
  if (!looksLikeDocFolderAsk(input.text)) return null;
  const t = fold(input.text);
  const folder = folderFromText(input.text);

  if (/guarda na pasta/.test(t) && folder) {
    const doc = await latestDoc(db, input.workspaceId);
    if (!doc) return "Manda o arquivo primeiro, depois eu guardo na pasta.";
    const meta = { ...((doc.metadata || {}) as Record<string, unknown>), folder };
    await db
      .update(documents)
      .set({
        classification: folder,
        metadata: meta,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, doc.id));
    return `Guardei *${doc.originalFilename || "o arquivo"}* na pasta *${folder}*.`;
  }

  if (/vence|prazo/.test(t)) {
    const when = parseNaturalDateTime(input.text, input.timezone);
    const doc = await latestDoc(db, input.workspaceId);
    if (!doc) return "Manda o arquivo primeiro.";
    if (!when?.isValid) return "Que dia vence?";
    const meta = {
      ...((doc.metadata || {}) as Record<string, unknown>),
      dueAt: when.toUTC().toISO(),
    };
    await db
      .update(documents)
      .set({ metadata: meta, updatedAt: new Date() })
      .where(eq(documents.id, doc.id));
    return `Prazo de *${doc.originalFilename || "o arquivo"}*: ${formatDeskDay(when)}.`;
  }

  const rows = await db.query.documents.findMany({
    where: and(eq(documents.workspaceId, input.workspaceId), isNull(documents.deletedAt)),
    orderBy: [desc(documents.createdAt)],
    limit: 40,
  });
  const q = folder || fold(input.text.replace(/acha (a foto|o documento|o arquivo|a imagem)( do| da)?/g, ""));
  const hits = rows.filter((row) => {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const hay = fold(
      `${row.originalFilename || ""} ${row.classification || ""} ${meta.folder || ""} ${meta.caption || ""}`
    );
    return !q || hay.includes(q) || (folder && (row.classification === folder || meta.folder === folder));
  });
  if (!hits.length) return "Não achei esse documento.";
  const tz = input.timezone || "America/Sao_Paulo";
  const lines = hits.slice(0, 5).map((row) => {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const due = meta.dueAt
      ? formatDeskDay(DateTime.fromISO(String(meta.dueAt)).setZone(tz))
      : "";
    const place = String(meta.folder || row.classification || "outros");
    return `• *${row.originalFilename || "arquivo"}* · ${place}${due ? ` · até ${due}` : ""}`;
  });
  return ["Achei:", ...lines].join("\n");
}

export function folderForNewDocument(filename: string, caption?: string | null): string {
  return guessDocFolder(filename, caption);
}
