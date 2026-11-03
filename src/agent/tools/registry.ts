import type { Db } from "@/db/client";

export type ToolContext = {
  db: Db;
  userId: string;
  workspaceId: string;
  conversationId: string;
  agentRunId: string;
  correlationId?: string;
  timezone: string;
  /** Texto inbound deste turno (para corrigir horário de lembrete etc.). */
  userText?: string;
  /** Server-resolved related document for this turn, if any */
  relatedDocumentId?: string | null;
};

export type ToolHandlerResult = {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  errorCode?: string;
};

export type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    ctx: ToolContext,
    args: Record<string, unknown>
  ) => Promise<ToolHandlerResult>;
};

const registry = new Map<string, RegisteredTool>();

export function registerTool(tool: RegisteredTool) {
  registry.set(tool.name, tool);
}

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function listTools(): RegisteredTool[] {
  return [...registry.values()];
}

export function toolDefinitionsForLlm() {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}
