// The operator and local workers share this directory. A time limit lets normal sweeping
// recover after an abandoned rehearsal. Permissionless third parties can still sweep.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PublicKey } from "@solana/web3.js";
import { heartbeatDir } from "./heartbeat";

const HOLD_MS = 10 * 60_000;
const pathOf = (round: PublicKey) => join(heartbeatDir(), `closure-${round.toBase58()}.hold`);

export function holdClosure(round: PublicKey): void {
  mkdirSync(heartbeatDir(), { recursive: true });
  const path = pathOf(round);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, String(Date.now() + HOLD_MS));
  renameSync(temp, path);
}

export function isClosureHeld(round: PublicKey): boolean {
  try {
    return Number(readFileSync(pathOf(round), "utf8")) > Date.now();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return false;
  }
}

export function releaseClosure(round: PublicKey): void {
  rmSync(pathOf(round), { force: true });
}
