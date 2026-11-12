export class AppError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof AppError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return Response.json({ error: "暂时没能完成操作，请稍后重试。", code: "internal_error" }, { status: 500 });
}

export function upstreamError(status: number): AppError {
  if (status === 401 || status === 403) return new AppError("模型验证未通过，请检查 Key、接口地址及账号权限。", 502, "authentication_failed");
  if (status === 404) return new AppError("未找到该模型或接口，请检查模型名称和接口地址。", 502, "model_not_found");
  if (status === 429) return new AppError("模型调用受限，可能是额度或请求频率限制，请稍后重试。", 429, "rate_limited");
  if (status === 400 || status === 422) return new AppError("模型没有接受本次请求，请核对接口地址、模型名称和账号支持范围。", 502, "provider_rejected");
  return new AppError("模型服务暂时没有响应，请稍后重试。", 502, "provider_unavailable");
}
