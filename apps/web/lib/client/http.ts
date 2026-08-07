type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
};

export class ClientApiError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(input: {
    code?: string;
    message: string;
    requestId?: string;
    status: number;
  }) {
    const reference = input.requestId ? ` (${input.requestId})` : "";
    super(`${input.message}${reference}`);
    this.name = "ClientApiError";
    this.code = input.code;
    this.requestId = input.requestId;
    this.status = input.status;
  }
}

export async function parseApiResponse<T>(
  response: Response,
  fallbackMessage = "请求失败",
): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ClientApiError({
      code: body.error?.code,
      message: body.error?.message ?? fallbackMessage,
      requestId: body.error?.requestId,
      status: response.status,
    });
  }
  return body;
}
