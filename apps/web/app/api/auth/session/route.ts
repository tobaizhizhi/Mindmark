import { jsonError } from "@/lib/server/http";
import { readWalletSession } from "@/lib/server/auth";

export async function GET() {
  try {
    const session = await readWalletSession();
    return Response.json({ session });
  } catch (error) {
    return jsonError(error);
  }
}

