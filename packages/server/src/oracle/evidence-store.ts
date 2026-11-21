// Evidence files: data/evidence/<market>.json holds the exact canonical bytes (§8.4).

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublicKey } from "@solana/web3.js";

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
  await mkdir(evidenceDir(dataDir), { recursive: true, mode: 0o700 });
  const path = evidencePath(dataDir, market);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, canonical, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
