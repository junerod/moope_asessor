import { and, desc, eq, isNull } from "drizzle-orm";
import { memories } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/ai/providers";
import { registerTool } from "./registry";

type ListMeta = {
  kind: "shopping_list";
  name: string;
  items: string[];
};

function normalizeName(n: string) {
  return n.trim().toLowerCase() || "mercado";
}

async function findList(
  ctx: { db: import("@/db/client").Db; workspaceId: string },
  name?: string
) {
  const rows = await ctx.db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, ctx.workspaceId),
      eq(memories.sourceType, "list"),
      eq(memories.status, "active"),
      isNull(memories.deletedAt)
    ),
    orderBy: [desc(memories.updatedAt)],
    limit: 20,
  });
  if (!rows.length) return null;
  if (!name) return rows[0];
  const want = normalizeName(name);
  return (
    rows.find((r) => {
      const meta = (r.metadata || {}) as ListMeta;
      return normalizeName(String(meta.name || "")) === want;
    }) || null
  );
}

registerTool({
  name: "upsert_shopping_list",
  description:
    "Cria ou atualiza lista (mercado, compras, afazeres). Use para 'lista de mercado: arroz, café', 'adiciona sabão na lista'.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Ex.: mercado, farmácia" },
      add_items: {
        type: "array",
        items: { type: "string" },
        description: "Itens a acrescentar",
      },
      set_items: {
        type: "array",
        items: { type: "string" },
        description: "Substitui a lista inteira",
      },
      remove_items: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
  async handler(ctx, args) {
    const name = normalizeName(String(args.name || "mercado"));
    let row = await findList(ctx, name);
    let items: string[] = [];
    if (row) {
      const meta = (row.metadata || {}) as ListMeta;
      items = Array.isArray(meta.items) ? [...meta.items] : [];
    }

    if (Array.isArray(args.set_items) && args.set_items.length) {
      items = args.set_items.map((i) => String(i).trim()).filter(Boolean);
    }
    if (Array.isArray(args.add_items)) {
      for (const raw of args.add_items) {
        const item = String(raw).trim();
        if (!item) continue;
        if (!items.some((i) => i.toLowerCase() === item.toLowerCase())) {
          items.push(item);
        }
      }
    }
    if (Array.isArray(args.remove_items)) {
      const remove = new Set(
        args.remove_items.map((i) => String(i).trim().toLowerCase())
      );
      items = items.filter((i) => !remove.has(i.toLowerCase()));
    }

    if (!items.length && !row) {
      return {
        ok: false,
        summary: "Diga os itens da lista (ex.: arroz, café, detergente).",
        errorCode: "empty",
      };
    }

    const content = `Lista ${name}: ${items.join(", ") || "(vazia)"}`;
    const metadata: ListMeta = { kind: "shopping_list", name, items };
    const embedder = getEmbeddingProvider();
    const [embedding] = await embedder.embed([content]);

    if (row) {
      await ctx.db
        .update(memories)
        .set({
          content,
          metadata,
          embedding,
          updatedAt: new Date(),
        })
        .where(and(eq(memories.id, row.id), eq(memories.workspaceId, ctx.workspaceId)));
    } else {
      const [created] = await ctx.db
        .insert(memories)
        .values({
          workspaceId: ctx.workspaceId,
          createdByUserId: ctx.userId,
          conversationId: ctx.conversationId,
          type: "note",
          content,
          sourceType: "list",
          embedding,
          embeddingModel:
            embedder.name === "openai" ? "text-embedding-3-small" : "local",
          status: "active",
          metadata,
        })
        .returning();
      row = created;
    }

    return {
      ok: true,
      summary: items.length
        ? `📝 Lista *${name}* (${items.length}):\n${items.map((i) => `• ${i}`).join("\n")}`
        : `Lista *${name}* está vazia.`,
      data: { list_id: row!.id, name, items },
    };
  },
});

registerTool({
  name: "show_shopping_list",
  description: "Mostra a lista de compras/mercado atual.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
  },
  async handler(ctx, args) {
    const row = await findList(
      ctx,
      args.name ? String(args.name) : undefined
    );
    if (!row) {
      return {
        ok: true,
        summary:
          "Ainda não tenho lista. Diga “lista de mercado: arroz, café e detergente”.",
        data: { items: [] },
      };
    }
    const meta = (row.metadata || {}) as ListMeta;
    const items = Array.isArray(meta.items) ? meta.items : [];
    return {
      ok: true,
      summary: items.length
        ? `📝 Lista *${meta.name || "mercado"}*:\n${items.map((i) => `• ${i}`).join("\n")}`
        : "Lista vazia.",
      data: { list_id: row.id, name: meta.name, items },
    };
  },
});
