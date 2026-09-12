import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAgentEmbeddingGatewayV3 } from "../src/embedding-v3.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote Agent Runner card embeddings", () => {
  it("returns vectors and sends one internal request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      embeddings: [[1, 0], [0, 1]],
      model: "text-embedding-test",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RemoteAgentEmbeddingGatewayV3({
      internalToken: "test-internal-token",
      baseUrl: "https://agents.example/",
    });

    await expect(gateway.embed(["first", "second"])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agents.example/v1/embeddings");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      texts: ["first", "second"],
    });
  });

  it("rejects an incomplete embedding response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      embeddings: [[0, 1]],
      model: "text-embedding-test",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const gateway = new RemoteAgentEmbeddingGatewayV3({
      baseUrl: "https://agents.example",
      internalToken: "test-internal-token",
    });

    await expect(gateway.embed(["first", "second"])).rejects.toThrow(/incomplete/u);
  });
});
