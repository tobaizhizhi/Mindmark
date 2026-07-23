import { Bytes32Schema } from "@mindmark/shared";
import { CompleteSessionRequestSchema } from "@mindmark/shared/schemas";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { completeSessionForOwner } from "@/lib/server/learning";

export async function POST(
  request: Request,
  context: { params: Promise<{ journeyId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { journeyId: rawJourneyId } = await context.params;
    const { sessionId } = CompleteSessionRequestSchema.parse(await request.json());
    return Response.json(
      await completeSessionForOwner(
        Bytes32Schema.parse(rawJourneyId),
        session.address,
        sessionId,
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}
