// POST /api/operator/settle-round { action, round? } — requires x-demo-password (spec-v2 §10.6).
import { handleOperatorSettle } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function POST(req: Request): Promise<Response> {
  return handleOperatorSettle(req);
}
