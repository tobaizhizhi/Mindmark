import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { deleteProjectForOwner } from "@/lib/server/project-deletion";
import { getProjectSummaryForOwner } from "@/lib/server/project-lifecycle/queries";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    return Response.json(
      await getProjectSummaryForOwner(Bytes32Schema.parse(rawProjectId), session.address),
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    await deleteProjectForOwner(Bytes32Schema.parse(rawProjectId), session.address);
    return Response.json({ deleted: true });
  } catch (error) {
    return jsonError(error);
  }
}
