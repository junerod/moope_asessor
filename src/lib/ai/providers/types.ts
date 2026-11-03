export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCallRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LanguageModelResult = {
  provider: string;
  model: string;
  content: string | null;
  toolCalls: ToolCallRequest[];
  inputTokens?: number;
  outputTokens?: number;
};

export type LanguageModelProvider = {
  name: string;
  complete(input: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    model?: string;
  }): Promise<LanguageModelResult>;
};

export type TranscriptionProvider = {
  name: string;
  transcribe(input: {
    buffer: Buffer;
    mimeType?: string;
  }): Promise<{ text: string; mocked?: boolean }>;
};

export type VisionProvider = {
  name: string;
  describe(input: {
    buffer: Buffer;
    mimeType?: string;
    prompt?: string;
  }): Promise<{ text: string; mocked?: boolean }>;
};
