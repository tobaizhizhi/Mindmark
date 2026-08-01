import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const runnerIdentity = Object.freeze({
  name: "Mindmark Agent Runner",
  roles: ["coordinator", "worker-0", "worker-1", "worker-2", "finalizer", "settlement"],
});

export function describeRunner(): string {
  return `${runnerIdentity.name}: ${runnerIdentity.roles.length} isolated roles configured`;
}

export function isDirectExecution(
  moduleUrl: string,
  argvEntry: string | undefined,
  cwd = process.cwd(),
): boolean {
  return Boolean(argvEntry && moduleUrl === pathToFileURL(resolve(cwd, argvEntry)).href);
}

export * from "./chain-v2.js";
export * from "./chapter-planner.js";
export * from "./chapter-design-agent.js";
export * from "./chapter-quality-gate.js";
export * from "./chapter-assembler.js";
export * from "./coordinator-v2.js";
export * from "./project-finalizer-v2.js";
export * from "./project-design-freezer.js";
export * from "./quality-evaluator-v3.js";
export * from "./model.js";
export * from "./outline-planning-agent.js";
export * from "./repository-v2.js";
export * from "./registry-reconciler-v2.js";
export * from "./reward.js";
export * from "./reward-v2.js";
export * from "./runtime-types.js";
export * from "./runtime.js";
export * from "./types-v2.js";
export * from "./validation-v2.js";
export * from "./worker-v2.js";
export * from "./workflow-dispatcher-v2.js";

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const { startRunnerFromEnvironment } = await import("./runtime.js");
  try {
    const coordinator = await startRunnerFromEnvironment();
    console.log(describeRunner());
    const stop = () => {
      coordinator.stop();
      process.exitCode = 0;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Agent Runner failed to start");
    process.exitCode = 1;
  }
}
