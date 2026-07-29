import { Bytes32Schema, MoveProjectRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { moveProjectForOwner } from "@/lib/server/library";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    const projectId = Bytes32Schema.parse(rawProjectId);
    const body = MoveProjectRequestSchema.parse(await request.json());
    await moveProjectForOwner(session.address, projectId, body.folderId);
    return Response.json({ projectId, folderId: body.folderId });
  } catch (error) {
    return jsonError(error);
  }
}
