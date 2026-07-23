import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/materials/demo/route";

describe("中文示例资料", () => {
  it("返回中文学习目标与正文，且不暴露英文示例名称", async () => {
    const response = GET();
    const body = (await response.json()) as {
      goal: string;
      pages: Array<{ pageNumber: number; text: string }>;
    };

    expect(body.goal).toBe("理解重入攻击的形成原因、调用顺序与常用防御方法");
    expect(body.pages).toHaveLength(8);
    expect(body.pages.every((page) => /[\u4e00-\u9fff]/u.test(page.text))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/reentrancy|understand/iu);
  });
});
