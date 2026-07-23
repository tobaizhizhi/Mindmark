import { Bytes32Schema, SaveCreateTransactionRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { confirmCreateJourneyTransaction } from "@/lib/server/registry";

export async function POST(
  request: Request,
  context: { params: Promise<{ journeyId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { journeyId: rawJourneyId } = await context.params;
    const journeyId = Bytes32Schema.parse(rawJourneyId);
    const { txHash } = SaveCreateTransactionRequestSchema.parse(await request.json());
    return Response.json(
      await confirmCreateJourneyTransaction(journeyId, session.address, txHash),
    );
  } catch (error) {
    return jsonError(error);
  }
}

