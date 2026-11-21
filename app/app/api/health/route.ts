// GET /api/health — keeper and bot heartbeats, RPC (spec-v2 §7.5).
import { handleHealth } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleHealth();
}
