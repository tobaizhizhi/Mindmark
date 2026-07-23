import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const runnerIdentity = Object.freeze({
  name: "Mindmark Agent Runner",
  roles: ["coordinator", "worker-0", "worker-1", "worker-2", "finalizer"],
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

export * from "./chain.js";
export * from "./coordinator.js";
export * from "./finalizer.js";
export * from "./model.js";
export * from "./repository.js";
export * from "./runtime.js";
export * from "./types.js";
export * from "./validation.js";
export * from "./worker.js";

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
