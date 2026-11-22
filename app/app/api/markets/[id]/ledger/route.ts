// GET /api/markets/:id/ledger (docs/spec-simulation.md §8): trade and settlement ledger from finalized events.
import { handleLedger } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleLedger((await ctx.params).id);
}
