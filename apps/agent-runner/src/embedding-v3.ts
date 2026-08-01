import { z } from "zod";

export interface CardEmbeddingGatewayV3 {
  readonly modelId: string;
  embed(texts: string[]): Promise<number[][]>;
}

const EmbeddingResponseSchema = z.object({
  data: z.array(z.object({
    index: z.number().int().nonnegative(),
    embedding: z.array(z.number().finite()).min(1),
  })).min(1),
}).passthrough();

function featureHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function features(value: string): string[] {
  const compact = value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  const characters = Array.from(compact);
  const result = [...characters];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    result.push(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}

export class DeterministicCardEmbeddingGatewayV3 implements CardEmbeddingGatewayV3 {
  readonly modelId = "deterministic-char-ngram-v1";

  constructor(private readonly dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 32) {
      throw new RangeError("Embedding dimensions must be an integer of at least 32");
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((value) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      for (const feature of features(value)) {
        const hash = featureHash(feature);
        const bucket = hash % this.dimensions;
        vector[bucket] = vector[bucket]! + ((hash & 0x8000_0000) === 0 ? 1 : -1);
      }
      return vector;
    });
  }
}

export class OpenAICompatibleCardEmbeddingGatewayV3 implements CardEmbeddingGatewayV3 {
  readonly modelId: string;

  constructor(private readonly configuration: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    timeoutMs?: number;
  }) {
    this.modelId = configuration.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const baseUrl = (this.configuration.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/u, "");
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.configuration.model,
        input: texts,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(this.configuration.timeoutMs ?? 60_000),
    });
    if (!response.ok) {
      throw new Error(`Embedding model request failed with status ${response.status}`);
    }
    const parsed = EmbeddingResponseSchema.parse(await response.json());
    const ordered = [...parsed.data].sort((left, right) => left.index - right.index);
    if (ordered.length !== texts.length || ordered.some((item, index) => item.index !== index)) {
      throw new Error("Embedding model returned incomplete or unordered indexes");
    }
    const dimensions = ordered[0]!.embedding.length;
    if (ordered.some((item) => item.embedding.length !== dimensions)) {
      throw new Error("Embedding model returned inconsistent vector dimensions");
    }
    return ordered.map((item) => item.embedding);
  }
}
