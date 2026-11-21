// POST /api/faucet { wallet } — 0.05 SOL + 25,000 mUSD, rate-limited (spec §9.3).
import { handleFaucet } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleFaucet(req);
}
