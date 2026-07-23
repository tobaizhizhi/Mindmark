import { AuthVerifyRequestSchema, AuthVerifyResponseSchema } from "@mindmark/shared";
import { cookies } from "next/headers";
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
  SupabaseAuthStore,
  verifySiweCredentials,
} from "@/lib/server/auth";
import { getServerEnvironment } from "@/lib/server/config";
import { jsonError } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = AuthVerifyRequestSchema.parse(await request.json());
    const environment = getServerEnvironment();
    const url = new URL(request.url);
    const store = new SupabaseAuthStore();
    const address = await verifySiweCredentials(
      body,
      { domain: url.host, uri: url.origin, chainId: environment.MONAD_CHAIN_ID },
      (walletAddress, nonce) => store.consumeNonce(walletAddress, nonce),
    );
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1_000).toISOString();
    await store.saveSession(
      address,
      hashSessionToken(token, environment.SESSION_SECRET),
      expiresAt,
    );
    (await cookies()).set({
      name: SESSION_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_DURATION_SECONDS,
    });

    return Response.json(AuthVerifyResponseSchema.parse({ address, expiresAt }));
  } catch (error) {
    return jsonError(error);
  }
}

