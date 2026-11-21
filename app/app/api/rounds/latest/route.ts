// GET /api/rounds/latest — Config.latest_round and its markets (spec-v2 §7.5, §10.2).
import { handleLatestRound } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleLatestRound();
}
