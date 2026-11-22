// GET /api/listings — listing addresses per hazard and their markets (docs/spec-multiperil.md §7.7).
import { handleListings } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleListings();
}
