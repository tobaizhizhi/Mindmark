import { requestEmbeddings } from "@mindmark/ai-client";

export interface CardEmbeddingGatewayV3 {
  readonly modelId: string;
  embed(texts: string[]): Promise<number[][]>;
}

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

export class RemoteAgentEmbeddingGatewayV3 implements CardEmbeddingGatewayV3 {
  readonly modelId = "agent-runner:embedding";

  constructor(private readonly configuration: {
    baseUrl: string;
    internalToken: string;
    timeoutMs?: number;
  }) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result = await requestEmbeddings(
      {
        baseUrl: this.configuration.baseUrl,
        internalToken: this.configuration.internalToken,
      },
      texts,
      this.configuration.timeoutMs ?? 60_000,
    );
    if (result.embeddings.length !== texts.length) {
      throw new Error("Embedding model returned incomplete or unordered indexes");
    }
    const dimensions = result.embeddings[0]!.length;
    if (result.embeddings.some((item) => item.length !== dimensions)) {
      throw new Error("Embedding model returned inconsistent vector dimensions");
    }
    return result.embeddings;
  }
}
