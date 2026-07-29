import { Bytes32Schema, ChapterProposalListSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { confirmProjectOutlineForOwner } from "@/lib/server/projects";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    const body = ChapterProposalListSchema.parse(await request.json());
    return Response.json(
      await confirmProjectOutlineForOwner(Bytes32Schema.parse(rawProjectId), session.address, body),
    );
  } catch (error) {
    return jsonError(error);
  }
}
