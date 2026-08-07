import { Bytes32Schema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { ApiError, jsonError } from "@/lib/server/http";
import {
  getProjectSourceFileForOwner,
  uploadProjectSourceFileForOwner,
} from "@/lib/server/project-files";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    return Response.json(await getProjectSourceFileForOwner(
      Bytes32Schema.parse(rawProjectId),
      session.address,
    ), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId: rawProjectId } = await context.params;
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file) || !("size" in file) || !("type" in file)) {
      throw new ApiError(400, "invalid_source_file", "请选择 PDF 文件");
    }
    return Response.json(await uploadProjectSourceFileForOwner(
      Bytes32Schema.parse(rawProjectId),
      session.address,
      file as Parameters<typeof uploadProjectSourceFileForOwner>[2],
    ), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
