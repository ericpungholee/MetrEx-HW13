import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heartbeatDir } from "./heartbeat";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEMO_TRADING_HOURS = 168;
export const SIM_SOL_FLOAT = 15_000_000n;
export const SPONSOR_SOL_FLOAT = 2_000_000_000n;
export const MAKER_SOL_FLOAT = 1_500_000_000n;
/**
 * Seeded mUSD per maker (docs/spec-simulation.md §3, §9). The maker worker divides this
 * across the four catalog markets to budget inventory and bid escrow.
 */
export const MAKER_CAPITAL = 1_500_000_000_000n;

export function readDemoFile<T>(name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(heartbeatDir(), name), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function writeDemoFile(name: string, value: unknown): void {
  const dir = heartbeatDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(tmp, path);
}

export interface DemoOperation {
  id: string;
  action: "reset_market" | "reset_demo" | "fast_forward";
  rounds: string[];
  phase: string;
  completed: boolean;
  failed?: boolean;
  replacements: Record<string, string>;
}

export const readDemoOperation = () => readDemoFile<DemoOperation>("operation.json");
export const writeDemoOperation = (op: DemoOperation) => writeDemoFile("operation.json", op);
export const fullResetHeld = () => {
  const op = readDemoOperation();
  return op?.action === "reset_demo" && !op.completed;
};
export const simulationPaused = () => readDemoFile<boolean>("simulation-paused.json") ?? false;
export const setSimulationPaused = (paused: boolean) => writeDemoFile("simulation-paused.json", paused);
