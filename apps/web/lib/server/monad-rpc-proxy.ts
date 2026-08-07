type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type MonadRpcProxyOptions = {
  fetcher?: typeof fetch;
  rpcUrls: string[];
  timeoutMs?: number;
};

const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_syncing",
  "net_version",
  "web3_clientVersion",
]);

function requestItems(payload: unknown): JsonRpcRequest[] | null {
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length === 0 || items.length > 20) return null;
  return items.every((item) => item !== null && typeof item === "object")
    ? items as JsonRpcRequest[]
    : null;
}

function errorResponse(payload: unknown, status: number, message: string): Response {
  const items = requestItems(payload);
  const id = items?.length === 1 ? items[0]?.id ?? null : null;
  return Response.json(
    { jsonrpc: "2.0", id, error: { code: -32098, message } },
    {
      status,
      headers: {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-origin": "*",
      },
    },
  );
}

export async function forwardMonadRpc(
  payload: unknown,
  options: MonadRpcProxyOptions,
): Promise<Response> {
  const items = requestItems(payload);
  if (!items) return errorResponse(payload, 400, "Invalid JSON-RPC request");
  if (items.some((item) => typeof item.method !== "string" || !ALLOWED_METHODS.has(item.method))) {
    return errorResponse(payload, 403, "JSON-RPC method is not allowed");
  }
  const rpcUrls = [...new Set(options.rpcUrls.filter(Boolean))];
  if (rpcUrls.length === 0) return errorResponse(payload, 503, "Monad RPC is not configured");

  const fetcher = options.fetcher ?? fetch;
  const body = JSON.stringify(payload);
  let lastStatus = 502;
  for (const rpcUrl of rpcUrls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);
    try {
      const response = await fetcher(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        cache: "no-store",
        signal: controller.signal,
      });
      const responseBody = await response.text();
      if (response.ok) {
        return new Response(responseBody, {
          status: response.status,
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
            "content-type": response.headers.get("content-type") ?? "application/json",
          },
        });
      }
      lastStatus = response.status;
    } catch {
      lastStatus = 502;
    } finally {
      clearTimeout(timeout);
    }
  }
  return errorResponse(payload, lastStatus === 429 ? 503 : 502, "Monad RPC endpoints are unavailable");
}

export function monadRpcUrls(configuredUrl: string): string[] {
  return [
    configuredUrl,
    "https://rpc.ankr.com/monad_testnet",
    "https://rpc-testnet.monadinfra.com",
  ];
}
