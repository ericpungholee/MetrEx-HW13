// POST /api/rpc — the browser's JSON-RPC endpoint: allowlisted methods forwarded to the server's
// RPC_URL, so a provider API key never reaches the browser.
import { handleRpcProxy } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleRpcProxy(req);
}
