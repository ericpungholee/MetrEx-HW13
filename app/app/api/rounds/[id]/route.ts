// GET /api/rounds/:id — by round id or address (spec-v2 §7.5).
import { handleRound } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleRound((await ctx.params).id);
}
