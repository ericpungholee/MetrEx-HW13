// Heartbeats for the bot worker and the keeper (spec-v2 §7.5 /api/health, §12 step 5).
// One small JSON file per process in METREX_HEARTBEAT_DIR (default <repo>/.metrex/heartbeat).
// Public operational data only: never keys, never settlement data.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envOrUndefined, expandHome, repoRoot } from "../env";

export type HeartbeatName = "bots" | "keeper" | "sim";

export interface Heartbeat {
  name: HeartbeatName;
  at: string;
  pid: number;
  /** Small public status fields (counts, last signature, last error text). */
  status: Record<string, string | number | boolean | null>;
}

export function heartbeatDir(): string {
  const d = envOrUndefined("METREX_HEARTBEAT_DIR");
  return d ? expandHome(d) : join(repoRoot(), ".metrex", "heartbeat");
}

export function writeHeartbeat(name: HeartbeatName, status: Heartbeat["status"], dir = heartbeatDir()): void {
  mkdirSync(dir, { recursive: true });
  const hb: Heartbeat = { name, at: new Date().toISOString(), pid: process.pid, status };
  const path = join(dir, `${name}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(hb) + "\n");
  renameSync(tmp, path);
}

export interface HeartbeatRead {
  name: HeartbeatName;
  alive: boolean;
  ageMs: number | null;
  heartbeat: Heartbeat | null;
}

/** `alive` = written within `maxAgeMs` (default 20 s). */
export function readHeartbeat(name: HeartbeatName, maxAgeMs = 20_000, dir = heartbeatDir(), now = Date.now()): HeartbeatRead {
  try {
    const hb = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Heartbeat;
    const ageMs = now - Date.parse(hb.at);
    return { name, alive: Number.isFinite(ageMs) && ageMs <= maxAgeMs, ageMs: Number.isFinite(ageMs) ? ageMs : null, heartbeat: hb };
  } catch {
    return { name, alive: false, ageMs: null, heartbeat: null };
  }
}
