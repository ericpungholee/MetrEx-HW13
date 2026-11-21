// GET /api/orders?maker= — a wallet's Order accounts in the recent rounds (from the cached state).
import { handleOrders } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleOrders(req);
}
