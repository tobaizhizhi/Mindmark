import { cookies } from "next/headers";
import {
  hashSessionToken,
  invalidateWalletSessionCache,
  SESSION_COOKIE,
  SupabaseAuthStore,
} from "@/lib/server/auth";
import { getServerEnvironment } from "@/lib/server/config";
import { jsonError } from "@/lib/server/http";

export async function POST() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (token) {
      const tokenHash = hashSessionToken(token, getServerEnvironment().SESSION_SECRET);
      await new SupabaseAuthStore().revokeSession(tokenHash);
      invalidateWalletSessionCache(tokenHash);
    }
    cookieStore.delete(SESSION_COOKIE);
    return Response.json({ signedOut: true });
  } catch (error) {
    return jsonError(error);
  }
}
