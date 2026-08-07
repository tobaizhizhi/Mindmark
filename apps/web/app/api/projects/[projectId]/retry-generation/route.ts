import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { retryProjectGenerationForOwner } from "@/lib/server/project-lifecycle/retry-generation";

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId } = await context.params;
    return Response.json(await retryProjectGenerationForOwner(
      Bytes32Schema.parse(projectId),
      session.address,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
