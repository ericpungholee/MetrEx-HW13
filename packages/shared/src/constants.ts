// Mirrors programs/metrex/src/constants.rs (spec §4.5, §5). FROZEN after Gate 0.
// Token amounts are bigint base units of mUSD; never JS numbers.

export const MUSD_DECIMALS = 6;
export const MUSD_UNIT = 1_000_000n;

export const MIN_COVERAGE = 10n * MUSD_UNIT;
export const MAX_COVERAGE_TARGET = 1_000_000n * MUSD_UNIT;
export const MIN_BPS = 1;
export const MAX_BPS = 9_999;
export const BPS_DENOMINATOR = 10_000n;
export const DEFAULT_TRIGGER_DISTANCE_M = 500;

export const MAX_ABS_LAT_E6 = 90_000_000;
export const MAX_ABS_LON_E6 = 180_000_000;

export const SCENARIO_PALISADES_2025 = 1;

/** Listing side (§5.6). Also the `side: u8` seed byte. */
export const Side = {
  Protection: 0,
  Risk: 1,
} as const;
export type Side = (typeof Side)[keyof typeof Side];

export const SEEDS = {
  config: "config",
  property: "property",
  market: "market",
  offer: "offer",
  vault: "vault",
  listing: "listing",
} as const;

export const LABEL_BYTES = 32;

/** Explorer links always target Devnet (CLAUDE.md). */
export const EXPLORER_BASE = "https://explorer.solana.com";
export const EXPLORER_CLUSTER_QUERY = "?cluster=devnet";

/** Plain-language trigger, shown on every market page (spec §3.3). */
export const TRIGGER_WORDING =
  "Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage.";

/** Shown on every market (spec §8.5). */
export const HISTORICAL_REPLAY_LABEL = "Historical simulation · outcomes may be known from public records";
