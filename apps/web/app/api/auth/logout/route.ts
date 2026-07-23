import { cookies } from "next/headers";
import {
  hashSessionToken,
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
      await new SupabaseAuthStore().revokeSession(
        hashSessionToken(token, getServerEnvironment().SESSION_SECRET),
      );
    }
    cookieStore.delete(SESSION_COOKIE);
    return Response.json({ signedOut: true });
  } catch (error) {
    return jsonError(error);
  }
}

