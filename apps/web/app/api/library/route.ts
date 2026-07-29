import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { getDocumentLibraryForOwner } from "@/lib/server/library";

export async function GET(request: Request) {
  try {
    const session = await requireWalletSession();
    const rawFolderId = new URL(request.url).searchParams.get("folderId");
    const folderId = rawFolderId ? z.string().uuid().parse(rawFolderId) : null;
    return Response.json(await getDocumentLibraryForOwner(session.address, folderId));
  } catch (error) {
    return jsonError(error);
  }
}
