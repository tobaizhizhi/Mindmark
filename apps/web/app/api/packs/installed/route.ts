import { requireWalletSession } from "@/lib/server/auth";
import { listInstalledCardPacks } from "@/lib/server/card-packs";
import { jsonError } from "@/lib/server/http";

export async function GET() {
  try {
    const session = await requireWalletSession();
    return Response.json(await listInstalledCardPacks(session.address));
  } catch (error) {
    return jsonError(error);
  }
}
