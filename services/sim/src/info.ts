// Simulated public risk bulletins (docs/spec-simulation.md §1.5, §2). Pure and deterministic: a
// bulletin in an epoch depends only on the seed, the hazard and the epoch number, so a restart
// sees the same history. Bulletins are random and unbiased in direction. They carry no
// settlement information: nothing here reads data/, the oracle or any hazard dataset.

import type { Hazard } from "@metrex/exchange";
import { rngFrom } from "./rng";

export interface Bulletin {
  id: string;
  hazard: Hazard;
  atMs: number;
  /** Log-odds shift a fully sensitive trader applies, signed (+ = more risk). */
  impact: number;
  headline: string;
}

export interface InfoConfig {
  epochMs: number;
  /** Probability of one bulletin per hazard per epoch. */
  rate: number;
  impact: [number, number];
  /** Signal decay time constant, minutes. */
  tauMin: number;
}

export const DEFAULT_INFO: InfoConfig = { epochMs: 10 * 60_000, rate: 0.4, impact: [0.15, 0.6], tauMin: 30 };

const HEADLINES: Record<Hazard, { up: string[]; down: string[] }> = {
  wildfire: {
    up: ["fire-weather outlook raised: dry offshore winds expected", "red-flag conditions forecast for the coastal foothills", "fuel-moisture readings drop below seasonal norms"],
    down: ["humidity forecast to rise as onshore flow returns", "wind advisory cancelled for the coastal foothills", "light rain in the extended outlook"],
  },
  hurricane: {
    up: ["tropical outlook raises formation odds in the Atlantic", "model guidance shifts a developing system west", "warm sea-surface anomaly widens near the Bahamas"],
    down: ["wind shear forecast to limit Atlantic development", "outlook lowers formation odds for the next week", "model guidance curves a system out to sea"],
  },
  earthquake: {
    up: ["regional seismic network reports a small foreshock-like cluster", "aftershock-forecast style advisory issued for the North Bay", "swarm activity noted near the West Napa fault zone"],
    down: ["seismic activity returns to background levels", "swarm advisory expires with no larger event", "network reports a quiet week in the North Bay"],
  },
  tornado: {
    up: ["severe-weather outlook upgrades central Iowa to enhanced risk", "strong low-level shear forecast across the Des Moines area", "storm-prediction guidance highlights supercell potential"],
    down: ["severe-weather outlook downgraded for central Iowa", "capping inversion expected to suppress storms", "cooler, stable air mass settles over the Midwest"],
  },
};

/** The bulletin of one hazard and epoch, if any. */
export function bulletinAt(seed: string, hazard: Hazard, epoch: number, cfg: InfoConfig = DEFAULT_INFO): Bulletin | undefined {
  const r = rngFrom(`${seed}:bulletin:${hazard}:${epoch}`);
  if (!r.chance(cfg.rate)) return undefined;
  const up = r.chance(0.5);
  const magnitude = r.uniform(cfg.impact[0], cfg.impact[1]);
  const at = epoch * cfg.epochMs + Math.floor(r.uniform(0, cfg.epochMs));
  const text = r.pick(HEADLINES[hazard][up ? "up" : "down"]);
  return { id: `${hazard}-${epoch}`, hazard, atMs: at, impact: up ? magnitude : -magnitude, headline: `Simulated bulletin: ${text}` };
}

/** Bulletins published in [fromMs, toMs]. */
export function bulletinsBetween(seed: string, hazard: Hazard, fromMs: number, toMs: number, cfg: InfoConfig = DEFAULT_INFO): Bulletin[] {
  const out: Bulletin[] = [];
  for (let e = Math.floor(fromMs / cfg.epochMs); e <= Math.floor(toMs / cfg.epochMs); e++) {
    const b = bulletinAt(seed, hazard, e, cfg);
    if (b && b.atMs >= fromMs && b.atMs <= toMs) out.push(b);
  }
  return out;
}

/** Decaying sum of recent bulletin impacts at `nowMs`, log-odds. */
export function signalAt(seed: string, hazard: Hazard, nowMs: number, cfg: InfoConfig = DEFAULT_INFO): number {
  const tau = cfg.tauMin * 60_000;
  return bulletinsBetween(seed, hazard, nowMs - 4 * tau, nowMs, cfg).reduce((s, b) => s + b.impact * Math.exp(-(nowMs - b.atMs) / tau), 0);
}
