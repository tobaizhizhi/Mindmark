import { describe, expect, it, vi } from "vitest";
import { forwardMonadRpc } from "@/lib/server/monad-rpc-proxy";

describe("Monad RPC proxy", () => {
  it("returns the first healthy RPC response when the configured endpoint cannot be fetched", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x279f" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const response = await forwardMonadRpc(
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      {
        fetcher,
        rpcUrls: ["https://primary.example", "https://fallback.example"],
        timeoutMs: 100,
      },
    );

    await expect(response.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: "0x279f" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects methods that a wallet does not need", async () => {
    await expect(forwardMonadRpc(
      { jsonrpc: "2.0", id: 1, method: "admin_nodeInfo", params: [] },
      { fetcher: vi.fn(), rpcUrls: ["https://rpc.example"], timeoutMs: 100 },
    )).resolves.toMatchObject({ status: 403 });
  });
});
