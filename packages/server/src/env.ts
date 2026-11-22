// Environment, paths and keypair loading (spec §9.1). Server-only.
// Keypairs live in ~/.config/metrex/*.json, never in the repo. Secret keys are never logged.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

export const DEFAULT_KEY_DIR = "~/.config/metrex";

/** Expands a leading `~` to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function envOrUndefined(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function requireEnv(name: string): string {
  const v = envOrUndefined(name);
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function keyDir(): string {
  return expandHome(envOrUndefined("METREX_KEY_DIR") ?? DEFAULT_KEY_DIR);
}

/**
 * Named keypairs and the env var that overrides each path.
 * Default path: `$METREX_KEY_DIR/<file>.json`.
 */
export const KEYPAIRS = {
  admin: { env: "ADMIN_KEYPAIR", file: "admin" },
  oracle: { env: "ORACLE_KEYPAIR", file: "oracle" },
  controller: { env: "CONTROLLER_KEYPAIR", file: "controller" },
  deployer: { env: "DEPLOYER_KEYPAIR", file: "deployer" },
  mintAuthority: { env: "MINT_AUTHORITY_KEYPAIR", file: "mint-authority" },
  faucet: { env: "FAUCET_KEYPAIR", file: "faucet" },
  botA: { env: "BOT_A_KEYPAIR", file: "bot-a" },
  botB: { env: "BOT_B_KEYPAIR", file: "bot-b" },
  botC: { env: "BOT_C_KEYPAIR", file: "bot-c" },
  homeownerDemo: { env: "HOMEOWNER_DEMO_KEYPAIR", file: "homeowner-demo" },
  judge1: { env: "JUDGE_1_KEYPAIR", file: "judge-1" },
  judge2: { env: "JUDGE_2_KEYPAIR", file: "judge-2" },
  judge3: { env: "JUDGE_3_KEYPAIR", file: "judge-3" },
  /** v2 keeper (spec-v2 §7.4): no authority, pays match and sweep fees. */
  keeper: { env: "KEEPER_KEYPAIR", file: "keeper" },
  /** V7 simulator fee payer (docs/spec-simulation.md §4): pays fees and ATA rent, never trades. */
  simSponsor: { env: "SIM_SPONSOR_KEYPAIR", file: "sim-sponsor" },
} as const;

export type KeypairName = keyof typeof KEYPAIRS;

export function keypairPath(name: KeypairName): string {
  const spec = KEYPAIRS[name];
  const fromEnv = envOrUndefined(spec.env);
  return expandHome(fromEnv ?? join(keyDir(), `${spec.file}.json`));
}

/** Reads a Solana CLI keypair file (JSON array of 64 bytes). */
export function loadKeypairFile(path: string): Keypair {
  const full = expandHome(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(full, "utf8"));
  } catch {
    // JSON parser errors can include fragments of the keypair file.
    throw new Error(`Cannot read keypair file ${full}`);
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error(`Keypair file ${full} is not a 64-byte JSON array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

const keypairCache = new Map<string, Keypair>();

export function loadKeypair(name: KeypairName): Keypair {
  const path = keypairPath(name);
  const cached = keypairCache.get(path);
  if (cached) return cached;
  const kp = loadKeypairFile(path);
  keypairCache.set(path, kp);
  return kp;
}

/** Finds the repo root (directory containing pnpm-workspace.yaml), searching upward from cwd. */
export function repoRoot(start: string = process.cwd()): string {
  const fromEnv = envOrUndefined("METREX_REPO_ROOT");
  if (fromEnv) return resolve(expandHome(fromEnv));
  let dir = resolve(/* turbopackIgnore: true */ start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot find repo root (pnpm-workspace.yaml) above ${start}`);
    dir = parent;
  }
}

/** `data/` directory (scenario registry, datasets, evidence). Override with METREX_DATA_DIR. */
export function dataDir(): string {
  const fromEnv = envOrUndefined("METREX_DATA_DIR");
  if (fromEnv) return resolve(expandHome(fromEnv));
  return join(repoRoot(), "data");
}

/** Production oracle files are mounted separately from the trading checkout. */
export function oracleDataDir(): string {
  const configured = envOrUndefined("METREX_ORACLE_DATA_DIR");
  if (configured) return resolve(expandHome(configured));
  if (process.env.NODE_ENV === "production") {
    throw new Error("METREX_ORACLE_DATA_DIR is required for production settlement");
  }
  return dataDir();
}

export function resolveFromRoot(p: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : join(/* turbopackIgnore: true */ repoRoot(), e);
}

export function parsePublicKey(value: string, what = "public key"): PublicKey {
  // Base58 Solana keys are 32–44 chars; reject anything else before parsing.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error(`Invalid ${what}`);
  try {
    const pk = new PublicKey(value);
    if (pk.toBase58() !== value) throw new Error("non-canonical");
    return pk;
  } catch {
    throw new Error(`Invalid ${what}`);
  }
}
