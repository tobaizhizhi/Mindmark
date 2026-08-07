import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { deleteCardPackInstallationForOwner } from "@/lib/server/card-packs";
import { jsonError } from "@/lib/server/http";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ installationId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { installationId: rawInstallationId } = await context.params;
    await deleteCardPackInstallationForOwner(session.address, z.string().uuid().parse(rawInstallationId));
    return Response.json({ deleted: true });
  } catch (error) {
    return jsonError(error);
  }
}
