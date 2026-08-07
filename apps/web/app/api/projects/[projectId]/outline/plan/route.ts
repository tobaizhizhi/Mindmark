import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { requestProjectOutlinePlanningForOwner } from "@/lib/server/project-lifecycle/outline";

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    return Response.json(await requestProjectOutlinePlanningForOwner(
      Bytes32Schema.parse(rawProjectId),
      session.address,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
