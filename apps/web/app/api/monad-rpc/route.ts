import { getServerEnvironment } from "@/lib/server/config";
import { forwardMonadRpc, monadRpcUrls } from "@/lib/server/monad-rpc-proxy";

const CORS_HEADERS = {
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-origin": "*",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 64 * 1024) {
    return Response.json({ error: "JSON-RPC request is too large" }, { status: 413, headers: CORS_HEADERS });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
  }
  const environment = getServerEnvironment();
  return forwardMonadRpc(payload, { rpcUrls: monadRpcUrls(environment.MONAD_RPC_URL) });
}
