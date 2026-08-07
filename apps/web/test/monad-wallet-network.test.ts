import { describe, expect, it, vi } from "vitest";
import { refreshMonadWalletRpc } from "@/lib/client/monad-wallet-network";

describe("Monad wallet network configuration", () => {
  it("puts the same-origin resilient RPC before public fallbacks", async () => {
    const request = vi.fn().mockResolvedValue(null);
    await refreshMonadWalletRpc({ request }, {
      origin: "http://localhost:3000",
      chainId: 10143,
      chainName: "Monad Testnet",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      publicRpcUrls: ["https://testnet-rpc.monad.xyz"],
      blockExplorerUrl: "https://testnet.monadexplorer.com",
    });

    expect(request).toHaveBeenCalledWith({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x279f",
        chainName: "Monad Testnet",
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: ["http://localhost:3000/api/monad-rpc", "https://testnet-rpc.monad.xyz"],
        blockExplorerUrls: ["https://testnet.monadexplorer.com"],
      }],
    });
  });
});
