// GET /api/operator/demo (status) and POST { action, round? } (no authentication)
// (docs/spec-simulation.md §10).
import { handleDemoAction, handleDemoStatus } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleDemoStatus();
}

export function POST(req: Request): Promise<Response> {
  return handleDemoAction(req);
}
