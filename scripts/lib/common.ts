// Shared helpers for Devnet scripts. Never prints secret keys.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_TRIGGER_DISTANCE_M,
  encodeLabel,
  MAX_ABS_LAT_E6,
  MAX_ABS_LON_E6,
  type ScenarioRegistry,
} from "@metrex/shared";
import { dataDir, explorerAddress, explorerTx, formatSol, getRpc, programId, redactUrl } from "@metrex/server";

export const args = process.argv.slice(2);
export const DRY_RUN = args.includes("--dry-run");

export function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export const log = {
  step: (s: string) => console.log(`\n== ${s}`),
  ok: (s: string) => console.log(`  ok    ${s}`),
  todo: (s: string) => console.log(`  ${DRY_RUN ? "would" : "do   "} ${s}`),
  warn: (s: string) => console.log(`  WARN  ${s}`),
  fail: (s: string) => console.log(`  FAIL  ${s}`),
  tx: (what: string, sig: string) => console.log(`  sent  ${what}: ${explorerTx(sig)}`),
  addr: (what: string, a: PublicKey | string) => console.log(`        ${what}: ${explorerAddress(a)}`),
};

export function banner(name: string): void {
  const rpc = getRpc();
  console.log(`${name}${DRY_RUN ? " (dry run: no transactions)" : ""}`);
  console.log(`  program ${programId().toBase58()}`);
  console.log(`  rpc     ${rpc.endpoints.map((c) => redactUrl(c.rpcEndpoint)).join(", ")}`);
}

export const sol = (lamports: bigint): string => `${formatSol(lamports)} SOL`;

// ---------- data/properties.json (Workstream B) ----------

export interface PropertyRow {
  property_id: number;
  label: string;
  lat_e6: number;
  lon_e6: number;
  scenario_id: number;
  trigger_distance_m: number;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Validates every row; returns rows plus human-readable errors (empty if all valid). */
export function validateProperties(raw: unknown, registry: ScenarioRegistry | undefined): {
  rows: PropertyRow[];
  errors: string[];
} {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { rows: [], errors: ["properties.json must be an array"] };
  const rows: PropertyRow[] = [];
  const seen = new Set<number>();
  raw.forEach((r: Record<string, unknown>, i) => {
    const where = `properties[${i}]`;
    const e: string[] = [];
    if (!isInt(r.property_id) || r.property_id < 0 || r.property_id > 0xffff) e.push("property_id must be a u16");
    else if (seen.has(r.property_id)) e.push(`duplicate property_id ${r.property_id}`);
    if (typeof r.label !== "string" || r.label.length === 0) e.push("label must be a non-empty string");
    else {
      try {
        encodeLabel(r.label);
      } catch (err) {
        e.push((err as Error).message);
      }
    }
    if (!isInt(r.lat_e6) || Math.abs(r.lat_e6) > MAX_ABS_LAT_E6) e.push("lat_e6 must be an integer within ±90°");
    if (!isInt(r.lon_e6) || Math.abs(r.lon_e6) > MAX_ABS_LON_E6) e.push("lon_e6 must be an integer within ±180°");
    if (!isInt(r.scenario_id) || r.scenario_id < 0 || r.scenario_id > 0xffff) e.push("scenario_id must be a u16");
    else if (registry && !registry[String(r.scenario_id)]) e.push(`scenario_id ${r.scenario_id} not in data/scenarios.json`);
    if (!isInt(r.trigger_distance_m) || r.trigger_distance_m <= 0 || r.trigger_distance_m > 0xffffffff) {
      e.push("trigger_distance_m must be a positive u32");
    } else if (r.trigger_distance_m !== DEFAULT_TRIGGER_DISTANCE_M) {
      e.push(`trigger_distance_m is ${r.trigger_distance_m}, spec §4.5 says ${DEFAULT_TRIGGER_DISTANCE_M}`);
    }
    if (e.length) errors.push(...e.map((x) => `${where}: ${x}`));
    else {
      seen.add(r.property_id as number);
      rows.push(r as unknown as PropertyRow);
    }
  });
  return { rows, errors };
}

export function readJsonIfExists<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function propertiesPath(): string {
  return join(dataDir(), "properties.json");
}

export function scenariosPath(): string {
  return join(dataDir(), "scenarios.json");
}

export function exitWith(problems: number): never {
  if (problems > 0) {
    console.log(`\nIncomplete: ${problems} problem(s) above.`);
    process.exit(1);
  }
  console.log("\nDone.");
  process.exit(0);
}
