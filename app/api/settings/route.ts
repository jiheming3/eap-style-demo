import { publicStatus, saveConfig } from "@/lib/config";
import { errorResponse } from "@/lib/errors";
import { assertLocalRequest, readBody } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json(await publicStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try { assertLocalRequest(request); return Response.json(await saveConfig(await readBody(request))); }
  catch (error) { return errorResponse(error); }
}
