// GET /api/evidence/:market — canonical evidence record (spec §8.4). `?raw=1` for exact bytes.
import { handleEvidence } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ market: string }> }): Promise<Response> {
  const { market } = await ctx.params;
  return handleEvidence(req, market);
}
