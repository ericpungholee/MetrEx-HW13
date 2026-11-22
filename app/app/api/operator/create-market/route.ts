// POST /api/operator/create-market { propertyId } (docs/spec-multiperil.md §7.7). No authentication.
import { handleCreateMarket } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function POST(req: Request): Promise<Response> {
  return handleCreateMarket(req);
}
