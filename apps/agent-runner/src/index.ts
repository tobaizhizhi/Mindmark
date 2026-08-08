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

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const { formatRunnerEnvironmentError, startRunnerFromEnvironment } = await import("./runtime.js");
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
    console.error(formatRunnerEnvironmentError(error));
    process.exitCode = 1;
  }
}
