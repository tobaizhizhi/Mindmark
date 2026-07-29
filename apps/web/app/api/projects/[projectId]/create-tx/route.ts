import { Bytes32Schema, SaveCreateProjectTransactionRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { confirmCreateProjectTransaction } from "@/lib/server/registry-v2";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    const { txHash } = SaveCreateProjectTransactionRequestSchema.parse(await request.json());
    return Response.json(
      await confirmCreateProjectTransaction(Bytes32Schema.parse(rawProjectId), session.address, txHash),
    );
  } catch (error) {
    return jsonError(error);
  }
}
