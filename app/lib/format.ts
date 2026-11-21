// Amount and rate formatting. All token math is bigint; never JS floats on amounts.
import { MUSD_DECIMALS, MUSD_UNIT } from "@metrex/exchange";

const EXPLORER_BASE = "https://explorer.solana.com";
const EXPLORER_CLUSTER_QUERY = "?cluster=devnet";

type Amountish = bigint | { toString(): string };

export function toBig(v: Amountish): bigint {
  return typeof v === "bigint" ? v : BigInt(v.toString());
}

function groupThousands(int: bigint): string {
  const s = int.toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format mUSD base units. Exact: trailing zeros trimmed, at least `minDecimals` shown.
 * 10_000_000_000n → "10,000.00"; 1_234_567n → "1.234567".
 */
export function formatMusd(v: Amountish, minDecimals = 2): string {
  const n = toBig(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const int = abs / MUSD_UNIT;
  let frac = (abs % MUSD_UNIT).toString().padStart(MUSD_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  return `${neg ? "-" : ""}${groupThousands(int)}${frac ? `.${frac}` : ""}`;
}

export function shortKey(key: { toBase58(): string } | string, chars = 4): string {
  const s = typeof key === "string" ? key : key.toBase58();
  return s.length <= chars * 2 + 1 ? s : `${s.slice(0, chars)}…${s.slice(-chars)}`;
}

export function explorerTx(signature: string): string {
  return `${EXPLORER_BASE}/tx/${signature}${EXPLORER_CLUSTER_QUERY}`;
}

export function explorerAddress(address: { toBase58(): string } | string): string {
  const s = typeof address === "string" ? address : address.toBase58();
  return `${EXPLORER_BASE}/address/${s}${EXPLORER_CLUSTER_QUERY}`;
}

/** Unix seconds (BN/bigint/number) → "2026-11-21 14:03:05" local, or "—" when zero. */
export function formatUnix(v: Amountish | number): string {
  const secs = typeof v === "number" ? v : Number(toBig(v));
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
