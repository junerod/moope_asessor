import { and, eq, isNull, ne } from "drizzle-orm";
import { tasks } from "@/db/schema";
import { registerTool } from "./registry";

registerTool({
  name: "create_task",
  description: "Cria uma tarefa no workspace do usuário.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
    },
    required: ["title"],
  },
  async handler(ctx, args) {
    const title = String(args.title || "").trim();
    if (!title) return { ok: false, summary: "Título vazio", errorCode: "empty_title" };
    const { looksLikeContactGroupIntent } = await import("@/domain/family-contacts");
    if (
      looksLikeContactGroupIntent(title) ||
      looksLikeContactGroupIntent(String(ctx.userText || ""))
    ) {
      return {
        ok: false,
        summary:
          "Isso entra no grupo, não vira tarefa. Diga de novo: adicionar Nome ao grupo CRM.",
        errorCode: "use_contact_group",
      };
    }
    const [row] = await ctx.db
      .insert(tasks)
      .values({
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        assignedUserId: ctx.userId,
        title,
        description: args.description ? String(args.description) : null,
        status: "open",
      })
      .returning();
    return {
      ok: true,
      summary: `Tarefa criada: ${row.title}`,
      data: { task_id: row.id },
    };
  },
});

registerTool({
  name: "list_tasks",
  description: "Lista tarefas abertas do workspace.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
  },
  async handler(ctx, args) {
    const { isInternalTestReminder } = await import("@/lib/reminder-copy");
    const rows = await ctx.db.query.tasks.findMany({
      where: and(
        eq(tasks.workspaceId, ctx.workspaceId),
        isNull(tasks.deletedAt),
        ne(tasks.status, "cancelled")
      ),
    });
    const q = args.query ? String(args.query).toLowerCase() : "";
    let filtered = q
      ? rows.filter((t) => t.title.toLowerCase().includes(q))
      : rows.filter((t) => t.status !== "completed");
    filtered = filtered.filter((t) => !isInternalTestReminder(t.title, null));
    if (!filtered.length) {
      return {
        ok: true,
        summary: "✅ Nenhuma tarefa aberta.",
        data: { tasks: [] },
      };
    }
    return {
      ok: true,
      summary: [
        `✅ *Tarefas abertas* (${filtered.length})`,
        "",
        ...filtered.map((t) => `• 📌 *${t.title}*`),
      ].join("\n"),
      data: {
        tasks: filtered.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
        })),
      },
    };
  },
});

registerTool({
  name: "complete_task",
  description: "Marca uma tarefa como concluída.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      title_query: { type: "string" },
    },
  },
  async handler(ctx, args) {
    let task = args.task_id
      ? await ctx.db.query.tasks.findFirst({
          where: and(
            eq(tasks.id, String(args.task_id)),
            eq(tasks.workspaceId, ctx.workspaceId)
          ),
        })
      : null;
    if (!task && args.title_query) {
      const q = String(args.title_query).toLowerCase();
      const rows = await ctx.db.query.tasks.findMany({
        where: and(eq(tasks.workspaceId, ctx.workspaceId), isNull(tasks.deletedAt)),
      });
      task = rows.find((t) => t.title.toLowerCase().includes(q)) || null;
    }
    if (!task) {
      return { ok: false, summary: "Tarefa não encontrada", errorCode: "not_found" };
    }
    await ctx.db
      .update(tasks)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.workspaceId, ctx.workspaceId)));
    return { ok: true, summary: `Tarefa concluída: ${task.title}`, data: { task_id: task.id } };
  },
});
