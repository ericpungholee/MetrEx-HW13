// Display helpers for the v2 exchange. Integer math only on amounts; prices are bps (1–9,999) of the
// 1 mUSD payout, shown in cents per share: 1 bps = 0.01¢, 80 bps = 0.80¢, 430 bps = 4.30¢
// (docs/spec-multiperil.md §5: fractional-cent prices are native to the on-chain bps).
import { catalogByProperty, OrderSide, Outcome, type MarketOutcomeName, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
import type { MarketSummary, RoundInfo } from "./exchange-client";

/** §10.1 required text (plain text, no pills). The wildfire sentence; other hazards use `payoutRule`. */
export const TRIGGER_SENTENCE =
  "Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage.";
export const REPLAY_DISCLOSURE = "Historical replay. The real outcome is public. Prices here are not forecasts.";
export const INVALID_DISCLOSURE = "If the market is declared invalid, every share pays 0.50 mUSD (50¢). Buying above 50¢ can lose money on invalid.";
export const LIQUIDITY_DISCLOSURE = "Liquidity is provided by MetrEx-operated market makers.";

/** Cents without the sign: 430 → "4.30", 80 → "0.80", 1 → "0.01", a half-tick midpoint 415.5 → "4.155". */
export function formatCents(bps: number): string {
  const whole = Math.floor(bps);
  const half = bps - whole >= 0.5;
  const body = `${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
  return half ? `${body}5` : body;
}

/** 430 → "4.30¢"; 80 → "0.80¢"; a half-tick midpoint 415.5 → "4.155¢". */
export function formatPrice(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  return `${formatCents(bps)}¢`;
}

/** Cents input "0.80" / "0.8¢" / "4.3" → 80 / 80 / 430 bps; null unless a whole number of bps in 1–9,999. */
export function parsePriceToBps(input: string): number | null {
  const m = /^\s*(\d{1,2})?(?:\.(\d{1,2}))?\s*¢?\s*$/.exec(input);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const bps = Number(m[1] ?? "0") * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bps >= 1 && bps <= 9_999 ? bps : null;
}

export const outcomeName = (o: OutcomeCode | number): "YES" | "NO" => (o === Outcome.Yes ? "YES" : "NO");
export const sideName = (s: OrderSideCode | number): "Buy" | "Sell" => (s === OrderSide.Buy ? "Buy" : "Sell");

export type MarketState = "Open" | "Trading closed" | "Resolved YES" | "Resolved NO" | "Invalid";

export function marketState(outcome: MarketOutcomeName, round: Pick<RoundInfo, "state">): MarketState {
  if (outcome === "yes") return "Resolved YES";
  if (outcome === "no") return "Resolved NO";
  if (outcome === "invalid") return "Invalid";
  return round.state === "open" ? "Open" : "Trading closed";
}

export const STATE_TONE: Record<MarketState, string> = {
  Open: "text-up",
  "Trading closed": "text-warn",
  "Resolved YES": "text-down",
  "Resolved NO": "text-ink",
  Invalid: "text-dim",
};

/** Catalog address for the four homepage markets, else the on-chain property label. */
export const marketTitle = (m: Pick<MarketSummary, "label" | "propertyId">): string =>
  catalogByProperty(m.propertyId)?.address ?? m.label ?? `Property ${m.propertyId}`;

/** The forward-looking catalog question, else the original wildfire question. */
export const question = (m: Pick<MarketSummary, "label" | "propertyId" | "triggerDistanceM">): string =>
  catalogByProperty(m.propertyId)?.question ??
  `Did the Palisades Fire's final mapped footprint come within ${m.triggerDistanceM} m of ${m.label ?? `Property ${m.propertyId}`}?`;

/**
 * The required plain-text payout rule for a market (§10.1, docs/spec-multiperil.md §7.1). Wildfire
 * keeps the original sentence verbatim; other hazards use their catalog rule.
 */
export function payoutRule(m: Pick<MarketSummary, "propertyId" | "scenarioId">): string {
  if (m.scenarioId === 1) return TRIGGER_SENTENCE;
  return catalogByProperty(m.propertyId)?.payoutRule ?? TRIGGER_SENTENCE;
}

/** Whole dollars of coverage → shares: one share pays 1 mUSD. */
export const coverageToShares = (dollars: bigint): bigint => dollars;

/** Shares are integers with 0 decimals. */
export const formatShares = (q: bigint): string => q.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
