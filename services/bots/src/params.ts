// Bot parameters (spec §7 table, §7.1 floors). Amounts are bigint mUSD base units.

import { MUSD_UNIT } from "@metrex/shared";
import type { KeypairName } from "@metrex/server";

export interface BotParams {
  id: "A" | "B" | "C";
  name: string;
  keypair: KeypairName;
  /** Initial quote, bps (§7). */
  bps: number;
  /** Offer size as a whole-percent of the market's coverage target. */
  sizePct: bigint;
  perMarketCap: bigint;
  totalExposureCap: bigint;
  /** Tier 2 requote floor and step, bps (§7.1). */
  floorBps: number;
  stepBps: number;
}

export const BOTS: readonly BotParams[] = [
  {
    id: "A",
    name: "A — Aggressive",
    keypair: "botA",
    bps: 400,
    sizePct: 40n,
    perMarketCap: 50_000n * MUSD_UNIT,
    totalExposureCap: 200_000n * MUSD_UNIT,
    floorBps: 350,
    stepBps: 10,
  },
  {
    id: "B",
    name: "B — Balanced",
    keypair: "botB",
    bps: 450,
    sizePct: 30n,
    perMarketCap: 30_000n * MUSD_UNIT,
    totalExposureCap: 150_000n * MUSD_UNIT,
    floorBps: 400,
    stepBps: 10,
  },
  {
    id: "C",
    name: "C — Conservative",
    keypair: "botC",
    bps: 500,
    sizePct: 30n,
    perMarketCap: 20_000n * MUSD_UNIT,
    totalExposureCap: 100_000n * MUSD_UNIT,
    floorBps: 450,
    stepBps: 10,
  },
];

/** Skip placing if SOL is below this (§7: 0.01 SOL). */
export const MIN_SOL_LAMPORTS = 10_000_000n;

/** §7.1 rate limits. */
export const REQUOTE_MIN_INTERVAL_MS = 5_000;
export const REQUOTE_MAX_PER_MARKET = 20;

/** §7.1: Risk-side listing price = collateral + 50% of premium (configurable). */
export const DEFAULT_LISTING_PREMIUM_PCT = 50n;
