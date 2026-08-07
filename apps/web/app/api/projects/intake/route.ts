import { ProjectIntakeRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { intakeProjectForOwner } from "@/lib/server/project-lifecycle/intake";

export async function POST(request: Request) {
  try {
    const session = await requireWalletSession();
    const body = ProjectIntakeRequestSchema.parse(await request.json());
    return Response.json(await intakeProjectForOwner(body, session.address));
  } catch (error) {
    return jsonError(error);
  }
}
