import { z } from "zod";
import { readWalletSession } from "@/lib/server/auth";
import { getPublishedCardPack } from "@/lib/server/card-packs";
import { jsonError } from "@/lib/server/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ packVersionId: string }> },
) {
  try {
    const session = await readWalletSession();
    const { packVersionId: rawPackVersionId } = await context.params;
    const packVersionId = z.string().uuid().parse(rawPackVersionId);
    return Response.json(await getPublishedCardPack(packVersionId, session?.address ?? null));
  } catch (error) {
    return jsonError(error);
  }
}
