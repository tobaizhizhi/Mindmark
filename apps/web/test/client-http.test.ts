import { describe, expect, it } from "vitest";
import { ClientApiError, parseApiResponse } from "@/lib/client/http";

describe("client HTTP responses", () => {
  it("returns successful JSON responses", async () => {
    const response = Response.json({ projectId: "project-1" });

    await expect(parseApiResponse<{ projectId: string }>(response)).resolves.toEqual({
      projectId: "project-1",
    });
  });

  it("preserves structured error evidence", async () => {
    const response = Response.json({
      error: { code: "project_failed", message: "生成失败", requestId: "request-1" },
    }, { status: 409 });

    const error = await parseApiResponse(response).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({
      code: "project_failed",
      message: "生成失败 (request-1)",
      requestId: "request-1",
      status: 409,
    });
  });

  it("uses the caller fallback for non-JSON failures", async () => {
    const response = new Response("upstream unavailable", { status: 503 });

    await expect(parseApiResponse(response, "AI 导师请求失败")).rejects.toMatchObject({
      message: "AI 导师请求失败",
      status: 503,
    });
  });
});
