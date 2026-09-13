import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

const rootEnvironmentPath = resolve(process.cwd(), "../../.env");
const rootAiEnvironmentKeys = [
  "AGENT_RUNNER_URL",
  "AGENT_RUNNER_INTERNAL_TOKEN",
] as const;

if (existsSync(rootEnvironmentPath)) {
  const rootEnvironment = parseEnv(readFileSync(rootEnvironmentPath, "utf8"));
  for (const key of rootAiEnvironmentKeys) {
    if (!process.env[key] && rootEnvironment[key]) process.env[key] = rootEnvironment[key];
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    turbopackMemoryLimit: 1024 * 1024 * 1024,
  },
};

export default nextConfig;
