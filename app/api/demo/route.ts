import { errorResponse } from "@/lib/errors";
import { assertLocalRequest } from "@/lib/guard";
import { workspace } from "@/lib/store";
import { createDemoContext, demoOverview } from "@/lib/demo-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const context = await createDemoContext(await workspace(), "catalog");
    return Response.json(demoOverview(context), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
