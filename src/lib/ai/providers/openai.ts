import OpenAI from "openai";
import { getEnv } from "@/config/env";
import type {
  LanguageModelProvider,
  LanguageModelResult,
  ToolCallRequest,
} from "./types";

export function createOpenAILanguageModelProvider(): LanguageModelProvider {
  const env = getEnv();
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  return {
    name: "openai",
    async complete({ system, messages, tools, model }) {
      if (!env.OPENAI_API_KEY) throw new Error("openai_api_key_missing");
      const chosen = model || env.OPENAI_MODEL;

      const response = await client.chat.completions.create({
        model: chosen,
        max_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => {
            if (m.role === "tool") {
              return {
                role: "tool" as const,
                tool_call_id: m.toolCallId || "",
                content: m.content,
              };
            }
            return {
              role: m.role as "user" | "assistant" | "system",
              content: m.content,
            };
          }),
        ],
        tools: tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        tool_choice: "auto",
      });

      const choice = response.choices[0]?.message;
      const toolCalls: ToolCallRequest[] = (choice?.tool_calls || [])
        .filter((tc): tc is Extract<typeof tc, { type?: "function" } & { function: { name: string; arguments: string } }> =>
          "function" in tc && Boolean((tc as { function?: unknown }).function)
        )
        .map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          };
        });

      const result: LanguageModelResult = {
        provider: "openai",
        model: chosen,
        content: choice?.content ?? null,
        toolCalls,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      };
      return result;
    },
  };
}
