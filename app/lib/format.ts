// Amount and rate formatting. All token math is bigint; never JS floats on amounts.
import { EXPLORER_BASE, EXPLORER_CLUSTER_QUERY, MUSD_DECIMALS, MUSD_UNIT } from "@metrex/shared";

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

/** Signed with an explicit "+" for P&L. */
export function formatSignedMusd(v: Amountish): string {
  const n = toBig(v);
  return n > 0n ? `+${formatMusd(n)}` : formatMusd(n);
}

/**
 * Parse a user-entered mUSD amount ("10,000", "12.5") into base units.
 * Returns null when not a valid non-negative amount with ≤ 6 decimals.
 */
export function parseMusd(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "").replace(/_/g, "");
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const intPart = m[1] ?? "0";
  const fracPart = m[2] ?? "";
  if (fracPart.length > MUSD_DECIMALS) return null;
  return BigInt(intPart) * MUSD_UNIT + BigInt(fracPart.padEnd(MUSD_DECIMALS, "0") || "0");
}

/** 420 → "4.20%" (integer math). */
export function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0");
  return `${whole}.${frac}%`;
}

/** "4.2" or "4.20" (percent) → 420 bps; null if not representable in whole bps. */
export function parsePercentToBps(input: string): number | null {
  const s = input.trim().replace(/%$/, "").trim();
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(bps) ? bps : null;
}

/** Percentage of part/whole with one decimal, bigint-safe: "60.0%". */
export function formatRatio(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0.0%";
  const permille = (part * 1000n) / whole;
  return `${permille / 10n}.${permille % 10n}%`;
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

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isZeroBytes(bytes: ArrayLike<number>): boolean {
  return Array.from(bytes).every((b) => b === 0);
}

/** Unix seconds (BN/bigint/number) → "2026-11-21 14:03:05" local, or "—" when zero. */
export function formatUnix(v: Amountish | number): string {
  const secs = typeof v === "number" ? v : Number(toBig(v));
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function timeAgo(unixSecs: number, nowMs = Date.now()): string {
  if (!unixSecs) return "—";
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSecs));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** lat_e6 → "34.045000" (display only; coordinates are approximate points). */
export function formatE6(v: number): string {
  const neg = v < 0;
  const a = Math.abs(v);
  return `${neg ? "-" : ""}${Math.floor(a / 1_000_000)}.${String(a % 1_000_000).padStart(6, "0")}`;
}
