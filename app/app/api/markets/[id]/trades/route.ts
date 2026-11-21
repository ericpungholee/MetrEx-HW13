// GET /api/markets/:id/trades (spec-v2 §7.5).
import { handleTrades } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleTrades((await ctx.params).id);
}
