import { AuthNonceRequestSchema, AuthNonceResponseSchema } from "@mindmark/shared";
import { createNonce, SupabaseAuthStore } from "@/lib/server/auth";
import { getServerEnvironment } from "@/lib/server/config";
import { jsonError } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = AuthNonceRequestSchema.parse(await request.json());
    const environment = getServerEnvironment();
    const nonce = createNonce();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
    const url = new URL(request.url);
    await new SupabaseAuthStore().saveNonce(body.address, nonce, expiresAt);

    return Response.json(
      AuthNonceResponseSchema.parse({
        nonce,
        expiresAt,
        chainId: environment.MONAD_CHAIN_ID,
        domain: url.host,
        uri: url.origin,
      }),
    );
  } catch (error) {
    return jsonError(error);
  }
}

