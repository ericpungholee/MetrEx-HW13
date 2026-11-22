// Trader key and record files (docs/spec-simulation.md §2). Keys live under $METREX_KEY_DIR/sim,
// never in the repo. population.json is public (wallets, archetypes, starting capital).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { keyDir, loadKeypairFile } from "@metrex/server/exchange";
import type { PopulationEntry } from "./population";

export const simDir = (): string => join(keyDir(), "sim");
export const traderKeyPath = (index: number): string => join(simDir(), `trader-${String(index + 1).padStart(3, "0")}.json`);
export const populationPath = (): string => join(simDir(), "population.json");
/** Starting capital minted per wallet; never minted twice (§2 finite capital). */
export const fundingPath = (): string => join(simDir(), "funding.json");

export function loadTrader(index: number): Keypair {
  return loadKeypairFile(traderKeyPath(index));
}

/** Creates the keypair file if missing (mode 0600). Returns the keypair and whether it was new. */
export function ensureTrader(index: number): { keypair: Keypair; created: boolean } {
  const path = traderKeyPath(index);
  if (existsSync(path)) return { keypair: loadKeypairFile(path), created: false };
  mkdirSync(simDir(), { recursive: true, mode: 0o700 });
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600, flag: "wx" });
  return { keypair, created: true };
}

export function readPopulation(): PopulationEntry[] {
  try {
    return JSON.parse(readFileSync(populationPath(), "utf8")) as PopulationEntry[];
  } catch {
    return [];
  }
}

export function writePopulation(rows: PopulationEntry[]): void {
  mkdirSync(simDir(), { recursive: true, mode: 0o700 });
  writeFileSync(populationPath(), JSON.stringify(rows, null, 2) + "\n");
}

export type FundingRecord = Record<string, { musd: string; at: string; signature: string | null }>;

export function readFunding(): FundingRecord {
  try {
    return JSON.parse(readFileSync(fundingPath(), "utf8")) as FundingRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return {};
  }
}

export function writeFunding(r: FundingRecord): void {
  mkdirSync(simDir(), { recursive: true, mode: 0o700 });
  const tmp = `${fundingPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n", { mode: 0o600, flush: true });
  renameSync(tmp, fundingPath());
}
