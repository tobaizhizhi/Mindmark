import { Bytes32Schema, SubmitReviewRequestSchema } from "@mindmark/shared";
import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { submitChapterReviewForOwner } from "@/lib/server/project-study";

const ChapterIdSchema = z.coerce.number().int().min(0).max(15);

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; chapterId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const params = await context.params;
    return Response.json(await submitChapterReviewForOwner(
      Bytes32Schema.parse(params.projectId),
      ChapterIdSchema.parse(params.chapterId),
      session.address,
      SubmitReviewRequestSchema.parse(await request.json()),
    ));
  } catch (error) {
    return jsonError(error);
  }
}
