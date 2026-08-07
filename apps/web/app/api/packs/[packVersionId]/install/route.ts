import { InstallCardPackRequestSchema } from "@mindmark/shared";
import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { installCardPackForOwner } from "@/lib/server/card-packs";
import { jsonError } from "@/lib/server/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ packVersionId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { packVersionId: rawPackVersionId } = await context.params;
    const packVersionId = z.string().uuid().parse(rawPackVersionId);
    const body = InstallCardPackRequestSchema.parse(await request.json().catch(() => ({})));
    return Response.json(await installCardPackForOwner(session.address, packVersionId, body));
  } catch (error) {
    return jsonError(error);
  }
}
