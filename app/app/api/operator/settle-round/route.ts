// POST /api/operator/settle-round { action, round? } (spec-v2 §10.6). No authentication.
import { handleOperatorSettle } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function POST(req: Request): Promise<Response> {
  return handleOperatorSettle(req);
}
