// Evidence files: data/evidence/<market>.json holds the exact canonical bytes (§8.4).

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublicKey } from "@solana/web3.js";
import type { ScenarioRegistry } from "@metrex/shared";

export function evidenceDir(dataDir: string): string {
  return join(dataDir, "evidence");
}

/** Path for a market. The name comes from a parsed PublicKey, so it can't traverse. */
export function evidencePath(dataDir: string, market: PublicKey): string {
  return join(evidenceDir(dataDir), `${market.toBase58()}.json`);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Atomic write (tmp + rename) so a reader never sees a partial file. */
export async function writeEvidence(dataDir: string, market: PublicKey, canonical: string): Promise<string> {
  await mkdir(evidenceDir(dataDir), { recursive: true });
  const path = evidencePath(dataDir, market);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, canonical, { encoding: "utf8" });
  await rename(tmp, path);
  return path;
}

export async function readEvidenceBytes(dataDir: string, market: PublicKey): Promise<Buffer | null> {
  try {
    return await readFile(evidencePath(dataDir, market));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function loadScenarioRegistry(dataDir: string): Promise<ScenarioRegistry> {
  const raw = await readFile(join(dataDir, "scenarios.json"), "utf8");
  return JSON.parse(raw) as ScenarioRegistry;
}
