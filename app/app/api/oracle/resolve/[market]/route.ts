// POST /api/oracle/resolve/:market — requires x-demo-password (spec §9.2). Server-only keys.
import { handleResolve } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ market: string }> }): Promise<Response> {
  const { market } = await ctx.params;
  return handleResolve(req, market);
}
