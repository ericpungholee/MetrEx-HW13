// GET /api/featured — one market per hazard for the homepage (docs/spec-multiperil.md §7.2).
import { handleFeatured } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleFeatured();
}
