import { RenameFolderRequestSchema } from "@mindmark/shared";
import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { deleteFolderForOwner, renameFolderForOwner } from "@/lib/server/library";

type FolderRouteContext = { params: Promise<{ folderId: string }> };

export async function PATCH(request: Request, context: FolderRouteContext) {
  try {
    const session = await requireWalletSession();
    const { folderId: rawFolderId } = await context.params;
    const folderId = z.string().uuid().parse(rawFolderId);
    const body = RenameFolderRequestSchema.parse(await request.json());
    await renameFolderForOwner(session.address, folderId, body.name);
    return Response.json({ folderId, name: body.name.trim() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: FolderRouteContext) {
  try {
    const session = await requireWalletSession();
    const { folderId: rawFolderId } = await context.params;
    await deleteFolderForOwner(session.address, z.string().uuid().parse(rawFolderId));
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
