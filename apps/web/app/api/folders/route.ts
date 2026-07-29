import { CreateFolderRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { createFolderForOwner } from "@/lib/server/library";

export async function POST(request: Request) {
  try {
    const session = await requireWalletSession();
    const body = CreateFolderRequestSchema.parse(await request.json());
    return Response.json(await createFolderForOwner(session.address, body), { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
