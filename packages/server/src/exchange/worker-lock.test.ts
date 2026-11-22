import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { holdClosure, isClosureHeld, releaseClosure } from "./closure-hold";
import { lockWorker } from "./worker-lock";

describe("local worker coordination", () => {
  it("refuses a second owner of an identity and permits an orderly restart", async () => {
    const program = Keypair.generate().publicKey;
    const identity = Keypair.generate().publicKey;
    const stop = await lockWorker(program, [identity]);
    try {
      await expect(lockWorker(program, [identity])).rejects.toThrow(/worker lease/);
    } finally {
      stop();
    }
    (await lockWorker(program, [identity]))();
  });

  it("holds only the selected round and recovers after closing or timing out", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrex-hold-"));
    vi.stubEnv("METREX_HEARTBEAT_DIR", dir);
    vi.useFakeTimers();
    const round = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    try {
      holdClosure(round);
      expect(isClosureHeld(round)).toBe(true);
      expect(isClosureHeld(other)).toBe(false);
      releaseClosure(round);
      expect(isClosureHeld(round)).toBe(false);
      holdClosure(round);
      vi.advanceTimersByTime(10 * 60_000);
      expect(isClosureHeld(round)).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
