import { describe, expect, it } from "vitest";
import { describeRunner, isDirectExecution, runnerIdentity } from "../src/index.js";

describe("runner workspace", () => {
  it("reserves three independent worker identities", () => {
    expect(runnerIdentity.roles.filter((role) => role.startsWith("worker-"))).toEqual([
      "worker-0",
      "worker-1",
      "worker-2",
    ]);
    expect(describeRunner()).toContain("5 isolated roles");
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
});
