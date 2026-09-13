import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteEmbeddingGatewayV3 } from "../src/embedding-v3.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote AI Gateway card embeddings", () => {
  it("returns vectors and sends one internal request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      embeddings: [[1, 0], [0, 1]],
      model: "text-embedding-test",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RemoteEmbeddingGatewayV3({
      internalToken: "test-internal-token",
      baseUrl: "https://gateway.example/",
    });

    await expect(gateway.embed(["first", "second"])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.example/v1/embeddings");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      texts: ["first", "second"],
    });
  });

  it("rejects an incomplete embedding response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      embeddings: [[0, 1]],
      model: "text-embedding-test",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const gateway = new RemoteEmbeddingGatewayV3({
      baseUrl: "https://gateway.example",
      internalToken: "test-internal-token",
    });

    await expect(gateway.embed(["first", "second"])).rejects.toThrow(/incomplete/u);
  });
});
