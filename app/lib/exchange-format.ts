// Display helpers for the v2 exchange. Integer math only on amounts; prices are bps (1–9,999),
// shown as mUSD per share (430 bps = 0.0430 mUSD, because one share pays 1 mUSD).
import { OrderSide, Outcome, type MarketOutcomeName, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
import type { MarketSummary, RoundInfo } from "./exchange-client";

/** §10.1 required text (plain text, no pills). */
export const TRIGGER_SENTENCE =
  "Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage.";
export const REPLAY_DISCLOSURE = "Historical replay. The real outcome is public. Prices here are not forecasts.";
export const INVALID_DISCLOSURE = "If the market is declared invalid, every share pays 0.50 mUSD. Buying above 0.50 can lose money on invalid.";
export const LIQUIDITY_DISCLOSURE = "Liquidity is provided by MetrEx-operated market makers.";

/** 430 → "0.0430"; a half-tick midpoint 415.5 → "0.04155". */
export function formatPrice(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  const whole = Math.floor(bps);
  const half = bps - whole >= 0.5;
  const s = String(whole).padStart(4, "0");
  const body = whole >= 10_000 ? "1.0000" : `0.${s}`;
  return half ? `${body}5` : body;
}

/** mUSD input "0.043" → 430 bps; null unless a whole number of bps in 1–9,999. */
export function parsePriceToBps(input: string): number | null {
  const m = /^\s*0?\.(\d{1,4})\s*$/.exec(input) ?? /^\s*0\s*$/.exec(input);
  if (!m || m[1] === undefined) return null;
  const bps = Number(m[1].padEnd(4, "0"));
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

export const marketTitle = (m: Pick<MarketSummary, "label" | "propertyId">): string => m.label ?? `Property ${m.propertyId}`;

export const question = (m: Pick<MarketSummary, "label" | "propertyId" | "triggerDistanceM">): string =>
  `Did the Palisades Fire's final mapped footprint come within ${m.triggerDistanceM} m of ${marketTitle(m)}?`;

/** Shares are integers with 0 decimals. */
export const formatShares = (q: bigint): string => q.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
