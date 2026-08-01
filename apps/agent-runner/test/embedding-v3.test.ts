import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleCardEmbeddingGatewayV3 } from "../src/embedding-v3.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible card embeddings", () => {
  it("returns vectors in input order and sends one batch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new OpenAICompatibleCardEmbeddingGatewayV3({
      apiKey: "embedding-key",
      model: "text-embedding-test",
      baseUrl: "https://models.example/v1/",
    });

    await expect(gateway.embed(["first", "second"])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://models.example/v1/embeddings");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "text-embedding-test",
      input: ["first", "second"],
    });
  });

  it("rejects an incomplete embedding response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 1, embedding: [0, 1] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const gateway = new OpenAICompatibleCardEmbeddingGatewayV3({
      apiKey: "embedding-key",
      model: "text-embedding-test",
    });

    await expect(gateway.embed(["first", "second"])).rejects.toThrow(/incomplete/u);
  });
});
