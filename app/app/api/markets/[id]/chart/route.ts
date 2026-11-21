// GET /api/markets/:id/chart (spec-v2 §7.5).
import { handleChart } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleChart((await ctx.params).id);
}
