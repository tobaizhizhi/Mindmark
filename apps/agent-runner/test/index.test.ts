import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeRunner, isDirectExecution, runnerIdentity } from "../src/index.js";
import { formatRunnerEnvironmentError, RunnerEnvironmentSchema } from "../src/runtime.js";

describe("runner workspace", () => {
  it("reserves three independent worker identities", () => {
    expect(runnerIdentity.roles.filter((role) => role.startsWith("worker-"))).toEqual([
      "worker-0",
      "worker-1",
      "worker-2",
    ]);
    expect(describeRunner()).toContain("6 isolated roles");
  });

  it("recognizes a relative tsx watch entry path as direct execution", () => {
    expect(
      isDirectExecution(
        "file:///workspace/apps/agent-runner/src/index.ts",
        "src/index.ts",
        "/workspace/apps/agent-runner",
      ),
    ).toBe(true);
    expect(
      isDirectExecution(
        "file:///workspace/apps/agent-runner/src/index.ts",
        "node_modules/vitest/vitest.mjs",
        "/workspace/apps/agent-runner",
      ),
    ).toBe(false);
  });

  it("loads the root development environment before starting the Runner", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: { dev?: string } };

    expect(packageJson.scripts?.dev).toContain("--env-file-if-exists=../../.env");
  });

  it("resolves Shared source subpaths without requiring a prebuilt dist directory", () => {
    const tsconfig = JSON.parse(
      readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };

    expect(tsconfig.compilerOptions?.paths?.["@mindmark/shared/schemas"]).toEqual([
      "../../packages/shared/src/schemas.ts",
    ]);
  });

  it("formats missing Railway variables without exposing values", () => {
    const result = RunnerEnvironmentSchema.safeParse({});
    expect(result.success).toBe(false);
    const message = formatRunnerEnvironmentError(result.success ? undefined : result.error);
    expect(message).toContain("MONAD_RPC_URL");
    expect(message).toContain("COORDINATOR_PRIVATE_KEY");
    expect(message).toContain("Mindmark Runner service");
    expect(message).not.toContain("undefined");
  });

  it("treats blank optional model endpoints as omitted", () => {
    const result = RunnerEnvironmentSchema.safeParse({
      MONAD_RPC_URL: "https://testnet-rpc.monad.xyz",
      MONAD_CHAIN_ID: "10143",
      REGISTRY_V2_ADDRESS: "0x1111111111111111111111111111111111111111",
      PROJECT_ESCROW_ADDRESS: "0x2222222222222222222222222222222222222222",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      AI_API_KEY: "ai-key",
      AI_MODEL: "model",
      AI_BASE_URL: "",
      AI_FALLBACK_API_KEY: "",
      AI_FALLBACK_MODEL: "",
      AI_FALLBACK_BASE_URL: "",
      COORDINATOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      WORKER_0_PRIVATE_KEY: `0x${"2".repeat(64)}`,
      WORKER_1_PRIVATE_KEY: `0x${"3".repeat(64)}`,
      WORKER_2_PRIVATE_KEY: `0x${"4".repeat(64)}`,
      REWARD_TREASURY_PRIVATE_KEY: `0x${"5".repeat(64)}`,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AI_BASE_URL).toBeUndefined();
      expect(result.data.AI_FALLBACK_API_KEY).toBeUndefined();
      expect(result.data.AI_FALLBACK_BASE_URL).toBe("https://api.deepseek.com/v1");
    }
  });
});
