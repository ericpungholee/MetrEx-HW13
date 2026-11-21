import { describe, expect, it } from "vitest";
import { aggregateStats, ProgramIndexer, type SignatureRow, type StatsSource, type TxSample } from "./indexer";

describe("aggregateStats", () => {
  it("counts totals, last 10 minutes, failures and fees", () => {
    const now = 1_000_000;
    const s: TxSample[] = [
      { signature: "a", blockTime: now - 30, fee: 5000n, failed: false },
      { signature: "b", blockTime: now - 600, fee: 5000n, failed: true },
      { signature: "c", blockTime: now - 601, fee: 10_000n, failed: false },
      { signature: "d", blockTime: null, fee: null, failed: false },
    ];
    expect(aggregateStats(s, now)).toEqual({
      totalTransactions: 4,
      last10Minutes: 2,
      failedTransactions: 1,
      totalFeesLamports: "20000",
      totalFeesSol: "0.00002",
      feesPending: 1,
    });
  });

  it("handles no transactions", () => {
    expect(aggregateStats([], 0)).toMatchObject({ totalTransactions: 0, totalFeesSol: "0", feesPending: 0 });
  });
});

/** Fake chain: `sigs` newest-first. */
function fakeSource(sigs: SignatureRow[], fee = 5000n) {
  const calls = { signatures: 0, fees: 0, feeSigs: [] as string[] };
  const src: StatsSource & { sigs: SignatureRow[] } = {
    sigs,
    async signatures({ before, until, limit }) {
      calls.signatures++;
      let start = 0;
      if (before) start = src.sigs.findIndex((r) => r.signature === before) + 1;
      let end = src.sigs.length;
      if (until) {
        const u = src.sigs.findIndex((r) => r.signature === until);
        if (u >= 0) end = u;
      }
      return src.sigs.slice(start, end).slice(0, limit);
    },
    async fees(batch) {
      calls.fees++;
      calls.feeSigs.push(...batch);
      return batch.map(() => fee);
    },
  };
  return { src, calls };
}

const rows = (n: number, t0: number, prefix = "s"): SignatureRow[] =>
  Array.from({ length: n }, (_, i) => ({ signature: `${prefix}${n - i}`, blockTime: t0 - i, failed: false }));

describe("ProgramIndexer", () => {
  it("pages history, then only fetches new signatures", async () => {
    let now = 2_000_000_000;
    const { src, calls } = fakeSource(rows(25, 1_999_999));
    const ix = new ProgramIndexer("prog", src, { pageSize: 10, feeBatchSize: 4, feeBatchesPerRefresh: 100, now: () => now });
    const s1 = await ix.getStats();
    expect(s1.totalTransactions).toBe(25);
    expect(s1.totalFeesLamports).toBe(String(25 * 5000));
    expect(s1.feesPending).toBe(0);
    expect(calls.signatures).toBe(3); // 10 + 10 + 5

    src.sigs = [...rows(3, 2_000_100, "n"), ...src.sigs];
    now += 10_000;
    const s2 = await ix.getStats();
    expect(s2.totalTransactions).toBe(28);
    expect(new Set(calls.feeSigs).size).toBe(28); // each fee fetched once
  });

  it("uses the cache inside the minimum interval", async () => {
    const now = 1_000;
    const { src, calls } = fakeSource(rows(2, 1));
    const ix = new ProgramIndexer("prog", src, { minIntervalMs: 5000, now: () => now });
    await ix.getStats();
    await ix.getStats();
    expect(calls.signatures).toBe(1);
  });

  it("fills fees gradually when bounded per refresh", async () => {
    let now = 0;
    const { src } = fakeSource(rows(10, 1));
    const ix = new ProgramIndexer("prog", src, { feeBatchSize: 2, feeBatchesPerRefresh: 2, minIntervalMs: 0, now: () => now });
    expect((await ix.getStats()).feesPending).toBe(6);
    now++;
    expect((await ix.getStats()).feesPending).toBe(2);
    now++;
    expect((await ix.getStats()).feesPending).toBe(0);
  });

  it("marks stats stale when a refresh fails after warm-up, and throws when cold", async () => {
    let now = 0;
    const { src } = fakeSource(rows(1, 1));
    const ix = new ProgramIndexer("prog", src, { minIntervalMs: 0, now: () => now });
    await ix.getStats();
    src.signatures = async () => {
      throw new Error("rpc down");
    };
    now++;
    const s = await ix.getStats();
    expect(s.stale).toBe(true);
    expect(s.totalTransactions).toBe(1);
    const cold = new ProgramIndexer("prog", src);
    await expect(cold.getStats()).rejects.toThrow("rpc down");
  });

  it("caps the first backfill and flags truncation", async () => {
    const { src } = fakeSource(rows(50, 1));
    const ix = new ProgramIndexer("prog", src, { pageSize: 10, maxBackfill: 20 });
    const s = await ix.getStats();
    expect(s.totalTransactions).toBe(20);
    expect(s.truncated).toBe(true);
  });

  it("keeps fees null when the transaction isn't available yet", async () => {
    const { src } = fakeSource(rows(2, 1));
    src.fees = async (b) => b.map(() => null);
    const ix = new ProgramIndexer("prog", src);
    expect((await ix.getStats()).feesPending).toBe(2);
  });
});
