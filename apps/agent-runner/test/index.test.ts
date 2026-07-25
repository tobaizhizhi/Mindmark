import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeRunner, isDirectExecution, runnerIdentity } from "../src/index.js";

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
});
