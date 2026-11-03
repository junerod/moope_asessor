import type { Db } from "@/db/client";
import { resolveProviderSecret, getProviderConfig } from "@/domain/providers";
import { getEnv, isProductionEnv } from "@/config/env";
import { createHeuristicLanguageModelProvider } from "./heuristic";
import { createOpenAILanguageModelProvider } from "./openai";
import {
  createLocalEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  getEmbeddingProvider,
  embeddingToSqlLiteral,
  cosineSimilarity,
} from "./embedding";
import {
  createOpenAIVisionProvider,
  createStubVisionProvider,
  createOpenAITranscriptionProvider,
  createStubTranscriptionProvider,
} from "./media-ai";
import type {
  LanguageModelProvider,
  TranscriptionProvider,
  VisionProvider,
} from "./types";
import type { EmbeddingProvider } from "./embedding";

export async function resolveLanguageModelProvider(
  db: Db,
  timezone?: string
): Promise<LanguageModelProvider> {
  const cfg = await getProviderConfig(db, "openai_llm");
  const env = getEnv();
  const key =
    (await resolveProviderSecret(db, "openai_llm", "api_key")) ||
    env.OPENAI_API_KEY;
  // DB enabled=true vence; se a linha existe disabled mas há key ENV (bootstrap),
  // ainda assim usa OpenAI — evita silêncio em produção por stub enabled=false.
  const enabled =
    cfg?.enabled === true ||
    (!cfg && Boolean(key)) ||
    (Boolean(key) && env.AI_PROVIDER === "openai");

  if (isProductionEnv()) {
    if (!enabled || !key) throw new Error("AI_PROVIDER_UNAVAILABLE");
    process.env.OPENAI_API_KEY = key;
    return createOpenAILanguageModelProvider();
  }

  if (enabled && key) {
    process.env.OPENAI_API_KEY = key;
    return createOpenAILanguageModelProvider();
  }
  return createHeuristicLanguageModelProvider(
    timezone || env.DEFAULT_TIMEZONE
  );
}

export async function resolveEmbeddingProvider(
  db: Db
): Promise<EmbeddingProvider> {
  const cfg = await getProviderConfig(db, "openai_embeddings");
  const key =
    (await resolveProviderSecret(db, "openai_embeddings", "api_key")) ||
    getEnv().OPENAI_API_KEY;
  const enabled = cfg?.enabled ?? Boolean(key);
  if (enabled && key) {
    process.env.OPENAI_API_KEY = key;
    return createOpenAIEmbeddingProvider();
  }
  if (isProductionEnv()) {
    throw new Error("EMBEDDING_PROVIDER_UNAVAILABLE");
  }
  return createLocalEmbeddingProvider();
}

export async function resolveVisionProvider(db: Db): Promise<VisionProvider> {
  const cfg = await getProviderConfig(db, "vision");
  const key =
    (await resolveProviderSecret(db, "vision", "api_key")) ||
    (await resolveProviderSecret(db, "openai_llm", "api_key")) ||
    getEnv().OPENAI_API_KEY;
  if ((cfg?.enabled ?? Boolean(key)) && key) {
    return createOpenAIVisionProvider(key);
  }
  return createStubVisionProvider();
}

export async function resolveTranscriptionProvider(
  db: Db
): Promise<TranscriptionProvider> {
  const cfg = await getProviderConfig(db, "transcription");
  const key =
    (await resolveProviderSecret(db, "transcription", "api_key")) ||
    (await resolveProviderSecret(db, "openai_llm", "api_key")) ||
    getEnv().OPENAI_API_KEY;
  if ((cfg?.enabled ?? Boolean(key)) && key) {
    return createOpenAITranscriptionProvider(key);
  }
  return createStubTranscriptionProvider();
}

export function getLanguageModelProvider(timezone?: string): LanguageModelProvider {
  const env = getEnv();
  if (env.AI_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    return createOpenAILanguageModelProvider();
  }
  if (isProductionEnv()) {
    throw new Error("AI_PROVIDER_UNAVAILABLE");
  }
  return createHeuristicLanguageModelProvider(
    timezone || env.DEFAULT_TIMEZONE
  );
}

export {
  getEmbeddingProvider,
  createLocalEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  embeddingToSqlLiteral,
  cosineSimilarity,
};

export {
  createStubTranscriptionProvider,
  createStubVisionProvider,
} from "./media-ai";

export type * from "./types";
