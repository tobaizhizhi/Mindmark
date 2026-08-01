import { requireOperatorSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { getLearningQualityOperations } from "@/lib/server/operations";

export async function GET() {
  try {
    await requireOperatorSession();
    return Response.json(await getLearningQualityOperations());
  } catch (error) {
    return jsonError(error);
  }
}
