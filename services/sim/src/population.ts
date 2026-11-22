// Simulated trader population (docs/spec-simulation.md §2). Pure: generated from a seed, with no
// keys and no I/O. The same seed and index always give the same personality, so a restart
// resumes the same traders.

import { MUSD_UNIT, type Hazard } from "@metrex/exchange";
import { rngFrom, type Rng } from "./rng";

export type Archetype = "retail" | "homeowner" | "risk" | "quant" | "momentum" | "large";

export const ARCHETYPES: readonly Archetype[] = ["retail", "homeowner", "risk", "quant", "momentum", "large"];

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  retail: "Retail speculator",
  homeowner: "Homeowner hedger",
  risk: "Risk investor",
  quant: "Quantitative trader",
  momentum: "Momentum trader",
  large: "Large trader",
};

export const HAZARDS: readonly Hazard[] = ["wildfire", "hurricane", "earthquake", "tornado"];

/** Counts per 100 traders (§2). */
export const MIX: Record<Archetype, number> = { retail: 35, homeowner: 25, risk: 20, quant: 10, momentum: 7, large: 3 };

interface ArchetypeSpec {
  capital: [number, number];
  /** Decisions per minute. */
  rate: [number, number];
  /** Fraction of capital committed per trade. */
  tradeFrac: [number, number];
  /** Mean and sd of the per-hazard belief bias, log-odds. */
  bias: [number, number];
  sensitivity: [number, number];
  stubbornness: [number, number];
  noise: [number, number];
  edge: [number, number];
  /** Probability that an entry is a resting limit order rather than a market order. */
  limitShare: number;
  maxExposureFrac: [number, number];
  /** How many hazards it follows. */
  hazards: [number, number];
  /**
   * Most shares of one outcome it will hold or bid for in one market, as a multiple of its capital
   * in mUSD (1 share pays 1 mUSD). Valuing positions at mid alone lets a trader buy millions of
   * sub-cent YES shares, which no maker can collateralise (docs/spec-simulation.md §2).
   */
  payoutMult: number;
}

const SPECS: Record<Archetype, ArchetypeSpec> = {
  retail: { capital: [500, 5_000], rate: [0.25, 1.0], tradeFrac: [0.04, 0.15], bias: [0.15, 0.5], sensitivity: [0.8, 1.6], stubbornness: [0.1, 0.4], noise: [0.25, 0.6], edge: [0.05, 0.25], limitShare: 0, maxExposureFrac: [0.3, 0.6], hazards: [1, 2], payoutMult: 3 },
  homeowner: { capital: [5_000, 30_000], rate: [0.1, 0.35], tradeFrac: [0.03, 0.1], bias: [0.25, 0.3], sensitivity: [0.5, 1.2], stubbornness: [0.3, 0.6], noise: [0.1, 0.25], edge: [0.3, 1.0], limitShare: 0.65, maxExposureFrac: [0.1, 0.3], hazards: [1, 1], payoutMult: 10 },
  risk: { capital: [20_000, 100_000], rate: [0.15, 0.5], tradeFrac: [0.02, 0.08], bias: [-0.45, 0.25], sensitivity: [0.3, 0.8], stubbornness: [0.3, 0.6], noise: [0.08, 0.2], edge: [0.08, 0.25], limitShare: 0.5, maxExposureFrac: [0.2, 0.5], hazards: [2, 4], payoutMult: 2 },
  quant: { capital: [25_000, 100_000], rate: [1.0, 2.5], tradeFrac: [0.01, 0.05], bias: [0, 0.08], sensitivity: [0.3, 0.7], stubbornness: [0.05, 0.2], noise: [0.02, 0.06], edge: [0.03, 0.08], limitShare: 0.5, maxExposureFrac: [0.1, 0.3], hazards: [3, 4], payoutMult: 0.25 },
  momentum: { capital: [5_000, 25_000], rate: [0.4, 1.2], tradeFrac: [0.05, 0.15], bias: [0, 0.15], sensitivity: [0.2, 0.6], stubbornness: [0.1, 0.3], noise: [0.05, 0.15], edge: [0.06, 0.15], limitShare: 0, maxExposureFrac: [0.2, 0.5], hazards: [1, 3], payoutMult: 2 },
  large: { capital: [250_000, 500_000], rate: [0.03, 0.08], tradeFrac: [0.04, 0.12], bias: [0, 0.5], sensitivity: [0.5, 1.0], stubbornness: [0.2, 0.5], noise: [0.1, 0.2], edge: [0.15, 0.4], limitShare: 0, maxExposureFrac: [0.15, 0.35], hazards: [1, 2], payoutMult: 0.2 },
};

export interface TraderProfile {
  index: number;
  /** "T001" … "T100". */
  id: string;
  archetype: Archetype;
  /** Starting capital, mUSD base units. Minted once; never topped up (§2). */
  capital: bigint;
  ratePerMin: number;
  tradeFrac: [number, number];
  hazards: Hazard[];
  /** Persistent per-hazard belief bias, log-odds. */
  bias: Record<Hazard, number>;
  sensitivity: number;
  stubbornness: number;
  noise: number;
  edge: number;
  limitShare: number;
  maxExposureFrac: number;
  /** Most shares of one outcome held plus bid for, per market (ArchetypeSpec.payoutMult × capital). */
  maxShares: bigint;
  /** Posts limit orders, so it holds a small SOL float for order rent (§4). */
  postsLimits: boolean;
  /** Momentum: look-back window, minutes, and log-odds trigger. */
  momentumWindowMin: number;
  momentumThreshold: number;
  /** Exit after this many minutes (momentum, retail). */
  holdMin: number;
  /** Homeowner: YES shares of coverage wanted (1 share pays 1 mUSD). */
  coverageShares: bigint;
  /** Limit order lifetime, seconds. */
  limitTtlS: number;
}

const r2 = (r: Rng, [lo, hi]: [number, number]) => r.uniform(lo, hi);

/** Archetype of each index, in a fixed interleaved order so any prefix of the population is mixed. */
export function archetypeOrder(n: number): Archetype[] {
  const counts = ARCHETYPES.map((a) => ({ a, want: (MIX[a] * n) / 100, got: 0 }));
  const out: Archetype[] = [];
  for (let i = 0; i < n; i++) {
    // Largest deficit first (deterministic largest-remainder interleave).
    const pick = counts.reduce((best, c) => ((c.want * (i + 1)) / n - c.got > (best.want * (i + 1)) / n - best.got ? c : best));
    pick.got++;
    out.push(pick.a);
  }
  return out;
}

export function generateTrader(seed: string, index: number, archetype: Archetype): TraderProfile {
  const r = rngFrom(`${seed}:trader:${index}`);
  const s = SPECS[archetype];
  const capitalMusd = Math.round(r.logUniform(s.capital[0], s.capital[1]));
  const nHaz = r.int(s.hazards[0], s.hazards[1]);
  const hazards = r.shuffle(HAZARDS).slice(0, nHaz);
  const bias = Object.fromEntries(HAZARDS.map((h) => [h, r.normal(s.bias[0], s.bias[1])])) as Record<Hazard, number>;
  return {
    index,
    id: `T${String(index + 1).padStart(3, "0")}`,
    archetype,
    capital: BigInt(capitalMusd) * MUSD_UNIT,
    ratePerMin: r2(r, s.rate),
    tradeFrac: s.tradeFrac,
    hazards,
    bias,
    sensitivity: r2(r, s.sensitivity),
    stubbornness: r2(r, s.stubbornness),
    noise: r2(r, s.noise),
    edge: r2(r, s.edge),
    limitShare: s.limitShare,
    maxExposureFrac: r2(r, s.maxExposureFrac),
    maxShares: BigInt(Math.floor(capitalMusd * s.payoutMult)),
    postsLimits: s.limitShare > 0,
    momentumWindowMin: r.uniform(2, 10),
    momentumThreshold: r.uniform(0.04, 0.12),
    holdMin: r.uniform(5, 30),
    coverageShares: BigInt(Math.round(r.logUniform(5_000, 40_000))),
    limitTtlS: Math.round(r.uniform(60, 240)),
  };
}

export function generatePopulation(seed: string, n = 100): TraderProfile[] {
  return archetypeOrder(n).map((a, i) => generateTrader(seed, i, a));
}

/** Public population record (§2): no keys, no strategy internals. */
export interface PopulationEntry {
  index: number;
  id: string;
  archetype: Archetype;
  address: string;
  capitalMusd: string;
}
