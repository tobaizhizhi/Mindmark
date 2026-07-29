import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { listProjectsForOwner } from "@/lib/server/projects";

export async function GET() {
  try {
    const session = await requireWalletSession();
    return Response.json(await listProjectsForOwner(session.address));
  } catch (error) {
    return jsonError(error);
  }
}
