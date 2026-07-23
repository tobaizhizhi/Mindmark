import { Bytes32Schema, SubmitReviewRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { submitReviewForOwner } from "@/lib/server/learning";

export async function POST(
  request: Request,
  context: { params: Promise<{ journeyId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { journeyId: rawJourneyId } = await context.params;
    const body = SubmitReviewRequestSchema.parse(await request.json());
    return Response.json(
      await submitReviewForOwner(
        Bytes32Schema.parse(rawJourneyId),
        session.address,
        body,
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}
