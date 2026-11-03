/**
 * Memória útil — fatos pessoais fáceis de gravar e consultar no Zap.
 * Ex.: “lembra que meu dentista é Dr. X na Asa Sul”
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { memories } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/ai/providers";

function norm(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function looksLikeUsefulMemoryIntent(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 400) return false;
  // Não roubar modo família
  if (/\bfamilia\b/.test(t)) return false;
  if (
    /^(lembra|anota|salva|guarda|registre)\s+(que\s+|disso\s+)?/.test(t)
  ) {
    return true;
  }
  if (
    /^(meu|minha|meus|minhas)\s+\w.{0,40}\s+(e|eh|sao)\s+/.test(t)
  ) {
    // evita confundir com “meu lembrete” / gastos
    if (/(gastei|recebi|lembre|compromisso|reais|r\$)/.test(t)) return false;
    return true;
  }
  if (
    /(o que (voce )?lembra|o que (voce )?sabe de mim|minhas memorias|lista memorias|o que sabe sobre mim)/.test(
      t
    )
  ) {
    return true;
  }
  if (/^(esqueci|esquece|apaga memoria|esquece que)\b/.test(t)) return true;
  return false;
}

export function parseUsefulMemorySave(
  text: string
): { content: string; type: string } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const m1 = raw.match(
    /^(?:lembra|anota|salva|guarda|registre)(?:\s+disso)?(?:\s+que)?\s*[:\-–]?\s*(.+)$/is
  );
  if (m1?.[1]?.trim() && m1[1].trim().length >= 4) {
    return { content: m1[1].trim().slice(0, 500), type: inferType(m1[1]) };
  }

  const m2 = raw.match(
    /^(meu|minha|meus|minhas)\s+(.+?)\s+(?:é|e|eh|são|sao)\s+(.+)$/is
  );
  if (m2) {
    const content = `${m2[1]} ${m2[2]} é ${m2[3]}`.replace(/\s+/g, " ").trim();
    if (content.length >= 8) {
      return { content: content.slice(0, 500), type: inferType(content) };
    }
  }
  return null;
}

function inferType(content: string): string {
  const t = norm(content);
  if (
    /(dentista|medico|médico|advogado|contador|professor|dono|mae|pai|esposa|marido|filho|amiga|amigo)/.test(
      t
    )
  ) {
    return "person";
  }
  if (/(prefiro|nao gosto|gosto de|sempre|nunca)/.test(t)) return "preference";
  if (/(empresa|cnpj|loja|escritorio)/.test(t)) return "company";
  return "fact";
}

export function isListMemoriesCommand(text: string): boolean {
  const t = norm(text);
  return /(o que (voce )?lembra|o que (voce )?sabe de mim|minhas memorias|lista memorias|o que sabe sobre mim)/.test(
    t
  );
}

async function saveFact(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    conversationId?: string | null;
    content: string;
    type: string;
  }
) {
  const embedder = getEmbeddingProvider();
  const [embedding] = await embedder.embed([input.content]);

  const [row] = await db
    .insert(memories)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      conversationId: input.conversationId || null,
      type: input.type,
      content: input.content,
      sourceType: "conversation",
      embedding,
      embeddingModel:
        embedder.name === "openai" ? "text-embedding-3-small" : "local",
      status: "active",
      metadata: { kind: "useful_fact", via: "useful_memory" },
    })
    .returning();
  return row;
}

export async function handleUsefulMemoryTurn(
  db: Db,
  input: {
    userId: string;
    workspaceId: string;
    conversationId?: string | null;
    text: string;
  }
): Promise<string> {
  if (isListMemoriesCommand(input.text)) {
    const rows = await db.query.memories.findMany({
      where: and(
        eq(memories.workspaceId, input.workspaceId),
        eq(memories.status, "active"),
        isNull(memories.deletedAt)
      ),
      orderBy: [desc(memories.createdAt)],
      limit: 15,
    });
    const facts = rows.filter((r) => {
      const meta = (r.metadata || {}) as Record<string, unknown>;
      return (
        meta.via === "useful_memory" ||
        ["fact", "person", "preference", "company"].includes(String(r.type))
      );
    });
    if (!facts.length) {
      return [
        "🧠 Ainda não guardei fatos pessoais.",
        "",
        "Exemplos:",
        "• *lembra que meu dentista é Dr. Silva na Asa Sul*",
        "• *minha placa é ABC1D23*",
        "• *prefiro lembretes de manhã*",
      ].join("\n");
    }
    return [
      "🧠 *O que eu lembro de você*",
      "────────────",
      ...facts.slice(0, 12).map((r, i) => `*${i + 1}.* ${r.content}`),
      "",
      "_Novo fato: “lembra que …”_",
    ].join("\n");
  }

  const parsed = parseUsefulMemorySave(input.text);
  if (!parsed) {
    return [
      "🧠 Posso guardar fatos úteis.",
      "",
      "• *lembra que meu dentista é Dr. X*",
      "• *minha academia é a Smart Fit Asa Norte*",
      "• *o que você lembra de mim?*",
    ].join("\n");
  }

  await saveFact(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId: input.conversationId,
    content: parsed.content,
    type: parsed.type,
  });

  const icon =
    parsed.type === "person"
      ? "👤"
      : parsed.type === "preference"
        ? "💫"
        : "🧠";

  return [
    `${icon} *Anotei!*`,
    parsed.content,
    "",
    "_Quando precisar: “o que você lembra de mim?”_",
  ].join("\n");
}
