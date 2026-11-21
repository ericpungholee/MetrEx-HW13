// GET /api/markets/:id — state, headline prices and volume (spec-v2 §7.5, §10.3).
import { handleMarket } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleMarket((await ctx.params).id);
}
