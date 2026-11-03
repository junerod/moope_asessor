import { createHash } from "crypto";
import { getEnv } from "@/config/env";

export type EmbeddingProvider = {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function localEmbedOne(text: string, dims = 1536): number[] {
  const vec = new Array(dims).fill(0);
  const tokens = tokenize(text);
  if (!tokens.length) tokens.push("empty");
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    for (let i = 0; i < dims; i++) {
      const b = hash[i % hash.length];
      const sign = b % 2 === 0 ? 1 : -1;
      vec[i] += sign * ((b + 1) / 256);
    }
  }
  // Phrase-level signal
  const phrase = createHash("sha256").update(tokens.join(" ")).digest();
  for (let i = 0; i < dims; i++) {
    vec[i] += ((phrase[i % phrase.length] / 255) - 0.5) * 0.1;
  }
  let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function createLocalEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "local",
    dimensions: 1536,
    async embed(texts) {
      return texts.map((t) => localEmbedOne(t));
    },
  };
}

export function createOpenAIEmbeddingProvider(): EmbeddingProvider {
  const env = getEnv();
  return {
    name: "openai",
    dimensions: 1536,
    async embed(texts) {
      if (!env.OPENAI_API_KEY) throw new Error("openai_api_key_missing");
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.OPENAI_EMBEDDING_MODEL,
          input: texts,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`openai_embedding_failed:${res.status}:${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const env = getEnv();
  if (env.EMBEDDING_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    return createOpenAIEmbeddingProvider();
  }
  return createLocalEmbeddingProvider();
}

export function embeddingToSqlLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}
