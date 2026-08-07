import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  DeploymentSchemaOutdatedError,
  deploymentSchemaOutdatedMessage,
  isDeploymentSchemaError,
} from "@mindmark/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function jsonError(error: unknown, requestId = randomUUID()): NextResponse {
  const response = (status: number, code: string, message: string) => NextResponse.json(
    { error: { code, message, requestId } },
    { status, headers: { "x-request-id": requestId } },
  );
  if (error instanceof ApiError) {
    return response(error.status, error.code, error.message);
  }
  if (error instanceof DeploymentSchemaOutdatedError) {
    return response(503, error.code, error.message);
  }
  if (isDeploymentSchemaError(error)) {
    return response(503, "deployment_schema_outdated", deploymentSchemaOutdatedMessage());
  }
  if (error instanceof ZodError) {
    return response(400, "invalid_request", error.issues[0]?.message ?? "Request validation failed");
  }

  console.error("Unhandled API error", { requestId, error });
  return response(500, "internal_error", "The request could not be completed");
}
