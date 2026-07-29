import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { getProjectOutlinePlanningOperationForOwner } from "@/lib/server/projects";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    const operationId = new URL(request.url).searchParams.get("operationId") ?? undefined;
    return Response.json(await getProjectOutlinePlanningOperationForOwner(
      Bytes32Schema.parse(rawProjectId),
      session.address,
      operationId,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
