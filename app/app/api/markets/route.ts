// GET /api/markets?round= — markets of a round, default the latest (spec-v2 §7.5).
import { handleMarkets } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleMarkets(req);
}
