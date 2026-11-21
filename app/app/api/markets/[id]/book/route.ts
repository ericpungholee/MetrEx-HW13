// GET /api/markets/:id/book (spec-v2 §7.5).
import { handleBook } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleBook(req, (await ctx.params).id);
}
