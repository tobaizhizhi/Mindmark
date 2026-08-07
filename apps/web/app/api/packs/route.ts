import { readWalletSession } from "@/lib/server/auth";
import { listPublishedCardPacks } from "@/lib/server/card-packs";
import { jsonError } from "@/lib/server/http";

export async function GET() {
  try {
    const session = await readWalletSession();
    return Response.json(await listPublishedCardPacks(session?.address ?? null));
  } catch (error) {
    return jsonError(error);
  }
}
