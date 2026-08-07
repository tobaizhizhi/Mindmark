import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

type FakeResult = { data: unknown; error: { code?: string; message?: string } | null };
type FakeQuery = {
  select: () => FakeQuery;
  eq: () => FakeQuery;
  maybeSingle: () => Promise<FakeResult>;
};
type FakeClient = { from: () => FakeQuery };

const mockState = vi.hoisted(() => ({ client: undefined as FakeClient | undefined }));
vi.mock("@/lib/server/supabase", () => ({ getSupabaseAdmin: () => mockState.client }));

import {
  getProjectSourceFileForOwner,
} from "@/lib/server/project-files";

const projectId = `0x${"12".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;

function fakeQuery(result: FakeResult): FakeQuery {
  const query = {} as FakeQuery;
  query.select = () => query;
  query.eq = () => query;
  query.maybeSingle = async () => result;
  return query;
}

describe("Project source file storage", () => {
  it("reports an un-deployed source file migration instead of hiding it as a missing PDF", async () => {
    const first = fakeQuery({
      data: null,
      error: { code: "42703", message: "column learning_projects.source_storage_bucket does not exist" },
    });
    mockState.client = { from: vi.fn().mockReturnValueOnce(first) };

    await expect(getProjectSourceFileForOwner(projectId, owner)).rejects.toMatchObject({
      code: "deployment_schema_outdated",
      missing: ["originalPdfStorage"],
    });
  });
});
