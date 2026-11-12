import { errorResponse } from "@/lib/errors";
import { assertLocalRequest, readBody } from "@/lib/guard";
import { createSession, listSessions, workspace } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json({ sessions: await listSessions(await workspace()) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = await readBody(request);
    return Response.json(await createSession(await workspace(), typeof body.scenarioId === "string" ? body.scenarioId : null));
  } catch (error) { return errorResponse(error); }
}
