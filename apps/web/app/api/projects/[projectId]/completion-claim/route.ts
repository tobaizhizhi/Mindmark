import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import {
  getLearningCompletionClaimStatus,
  reviewLearningCompletionClaim,
} from "@/lib/server/learning-completion";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId } = await context.params;
    return Response.json(await getLearningCompletionClaimStatus(
      Bytes32Schema.parse(projectId),
      session.address,
    ));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId } = await context.params;
    return Response.json(await reviewLearningCompletionClaim(
      Bytes32Schema.parse(projectId),
      session.address,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
