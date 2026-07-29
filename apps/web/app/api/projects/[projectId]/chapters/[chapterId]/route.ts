import { Bytes32Schema } from "@mindmark/shared";
import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { getChapterStudyForOwner } from "@/lib/server/project-study";

const ChapterIdSchema = z.coerce.number().int().min(0).max(15);

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string; chapterId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const params = await context.params;
    return Response.json(await getChapterStudyForOwner(
      Bytes32Schema.parse(params.projectId),
      ChapterIdSchema.parse(params.chapterId),
      session.address,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
