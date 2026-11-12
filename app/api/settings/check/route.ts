import { markVerified, publicStatus, readConfig } from "@/lib/config";
import { AppError, errorResponse } from "@/lib/errors";
import { assertLocalRequest } from "@/lib/guard";
import { callModel } from "@/lib/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const config = await readConfig();
    const response = await callModel(config, [], false, request.signal, true);
    const result = await response.json();
    if (!Array.isArray(result.choices) || result.choices.length === 0) throw new AppError("接口返回格式不符合预期，请核对接口地址。", 502);
    markVerified(config);
    return Response.json(await publicStatus());
  } catch (error) { return errorResponse(error); }
}
