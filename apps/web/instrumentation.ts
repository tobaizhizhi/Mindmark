export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs"
    || process.env.NEXT_PHASE === "phase-production-build"
  ) return;
  const { assertWebSchemaCapabilities } = await import("./lib/server/schema-capabilities");
  await assertWebSchemaCapabilities();
}
