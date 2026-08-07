import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { getProjectProgressForOwner } from "@/lib/server/project-lifecycle/progress";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId } = await context.params;
    return Response.json(await getProjectProgressForOwner(
      Bytes32Schema.parse(projectId),
      session.address,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
