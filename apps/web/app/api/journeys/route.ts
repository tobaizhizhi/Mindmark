import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { listJourneysForOwner } from "@/lib/server/journeys";

export async function GET() {
  try {
    const session = await requireWalletSession();
    return Response.json(await listJourneysForOwner(session.address));
  } catch (error) {
    return jsonError(error);
  }
}
