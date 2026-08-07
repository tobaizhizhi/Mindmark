type Eip1193Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};

type MonadWalletNetwork = {
  origin: string;
  chainId: number;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  publicRpcUrls: readonly string[];
  blockExplorerUrl: string;
};

export function isEip1193Provider(value: unknown): value is Eip1193Provider {
  return Boolean(value && typeof value === "object" && "request" in value
    && typeof (value as { request?: unknown }).request === "function");
}

export async function refreshMonadWalletRpc(
  provider: Eip1193Provider,
  network: MonadWalletNetwork,
): Promise<void> {
  const resilientRpcUrl = new URL("/api/monad-rpc", network.origin).toString();
  const rpcUrls = [...new Set([resilientRpcUrl, ...network.publicRpcUrls])];
  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: `0x${network.chainId.toString(16)}`,
        chainName: network.chainName,
        nativeCurrency: network.nativeCurrency,
        rpcUrls,
        blockExplorerUrls: [network.blockExplorerUrl],
      }],
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === -32601 || /already\s+(exists|added|registered)|method\s+not\s+supported/iu.test(message)) return;
    throw error;
  }
}

export function monadCreationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|http request failed|network request|timed? out|timeout/iu.test(message)) {
    return "Monad RPC 暂时无法连接，钱包网络已刷新，请再次点击创建项目";
  }
  return message || "Monad 交易失败";
}
