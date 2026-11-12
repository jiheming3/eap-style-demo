import { errorResponse } from "@/lib/errors";
import { assertLocalRequest } from "@/lib/guard";
import { requireSession, serialize, workspace } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertLocalRequest(request);
    return Response.json(serialize(await requireSession(await workspace(), (await context.params).id)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
