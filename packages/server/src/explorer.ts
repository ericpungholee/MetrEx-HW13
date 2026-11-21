// Explorer links always use ?cluster=devnet (CLAUDE.md).

import type { PublicKey } from "@solana/web3.js";
import { EXPLORER_BASE, EXPLORER_CLUSTER_QUERY } from "@metrex/shared";

export function explorerTx(signature: string): string {
  return `${EXPLORER_BASE}/tx/${signature}${EXPLORER_CLUSTER_QUERY}`;
}

export function explorerAddress(address: PublicKey | string): string {
  const a = typeof address === "string" ? address : address.toBase58();
  return `${EXPLORER_BASE}/address/${a}${EXPLORER_CLUSTER_QUERY}`;
}
