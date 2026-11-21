// GET /api/stats — program transaction count and total fees (spec §10.5).
import { handleStats } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleStats();
}
