import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { listChaptersForOwner } from "@/lib/server/project-lifecycle/queries";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    return Response.json(
      await listChaptersForOwner(Bytes32Schema.parse(rawProjectId), session.address),
    );
  } catch (error) {
    return jsonError(error);
  }
}
