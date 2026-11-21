// Offline sample data for the v2 pages, served only when NEXT_PUBLIC_USE_FIXTURES=1 (next.config.ts
// refuses production builds with it on, and every write throws FixtureModeError). Shapes match the
// §7.5 API JSON. The book is the §8.2 default ladder at zero inventory; there are no trades, so the
// chart shows "No quotes or trades yet" rather than invented points.

import { PublicKey } from "@solana/web3.js";

const key = (n: number): string => new PublicKey(new Uint8Array(32).fill(n)).toBase58();

export const FIXTURE_KEYS = {
  round: key(1),
  market1: key(2),
  market2: key(3),
  botA: key(4),
  botB: key(5),
  botC: key(6),
} as const;

const now = Math.floor(Date.now() / 1000);

const round = {
  address: FIXTURE_KEYS.round,
  roundId: "1",
  scenarioId: 1,
  datasetSha256: "00".repeat(32),
  label: "Palisades replay #1 (fixture)",
  status: "open",
  state: "open",
  createdAt: String(now - 600),
  tradingEndsAt: String(now + 86_400),
  closedAt: "0",
  marketCount: 2,
  resolvedCount: 0,
};

const market = (address: string, propertyId: number, label: string, latE6: number, lonE6: number) => ({
  address,
  round: FIXTURE_KEYS.round,
  propertyId,
  label,
  latE6,
  lonE6,
  triggerDistanceM: 500,
  vault: key(20 + propertyId),
  outcome: "unresolved",
  resolutionPath: 0,
  invalidReason: 0,
  resolvedAt: "0",
  evidenceHash: "00".repeat(32),
  yesMint: key(30 + propertyId),
  noMint: key(40 + propertyId),
  pairsOutstanding: "6000",
});

// Fixture points are placeholders near the fire area, not registered property coordinates.
const markets = [market(FIXTURE_KEYS.market1, 1, "Home #1042 (fixture)", 34_045_000, -118_530_000), market(FIXTURE_KEYS.market2, 2, "Home #2210 (fixture)", 34_080_000, -118_600_000)];

type Row = [maker: string, priceBps: number, qty: number, seq: number];
// §8.2 at zero inventory: YES bids 410 C, 400 B, 370 A; asks 430 A, 500 B, 590 C. NO = complements.
const yesBids: Row[] = [[FIXTURE_KEYS.botC, 410, 100, 5], [FIXTURE_KEYS.botB, 400, 150, 3], [FIXTURE_KEYS.botA, 370, 200, 1]];
const yesAsks: Row[] = [[FIXTURE_KEYS.botA, 430, 200, 2], [FIXTURE_KEYS.botB, 500, 150, 4], [FIXTURE_KEYS.botC, 590, 100, 6]];
const noBids: Row[] = yesAsks.map(([m, p, q, s]) => [m, 10_000 - p, q, s + 6]);
const noAsks: Row[] = yesBids.map(([m, p, q, s]) => [m, 10_000 - p, q, s + 6]);

const levels = (rows: Row[]) =>
  rows.map(([maker, priceBps, qty, seq]) => ({ priceBps, quantity: String(qty), orders: [{ address: key(100 + seq), maker, remaining: String(qty), seq: String(seq) }] }));

const book = (outcome: 0 | 1) => {
  const bids = outcome === 0 ? yesBids : noBids;
  const asks = outcome === 0 ? yesAsks : noAsks;
  const best = (rows: Row[]) => rows[0]?.[1] ?? null;
  return {
    outcome,
    bids: levels(bids),
    asks: levels(asks),
    bestBidBps: best(bids),
    bestAskBps: best(asks),
    spreadBps: (best(asks) ?? 0) - (best(bids) ?? 0),
    bidDepth: String(bids.reduce((a, r) => a + r[2], 0)),
    askDepth: String(asks.reduce((a, r) => a + r[2], 0)),
  };
};

/** The JSON the §7.5 API would return for `path`. */
export function fixtureApi(path: string): Record<string, unknown> {
  const url = new URL(path, "http://fixture");
  const p = url.pathname;
  if (p === "/api/rounds/latest" || p === "/api/rounds/1" || p === `/api/rounds/${FIXTURE_KEYS.round}`) return { ...round, markets };
  if (p.startsWith("/api/rounds/")) throw new Error("Round not found");
  if (p === "/api/health") {
    return {
      rpc: { ok: true, slot: 1 },
      keeper: { alive: true },
      bots: { alive: true },
      matching: "running",
      marketMakers: [
        { name: "A", address: FIXTURE_KEYS.botA },
        { name: "B", address: FIXTURE_KEYS.botB },
        { name: "C", address: FIXTURE_KEYS.botC },
      ],
    };
  }
  if (p === "/api/orders") return { orders: [] };
  const m = /^\/api\/markets\/([^/]+)(\/[a-z]+)?$/.exec(p);
  const mk = markets.find((x) => x.address === m?.[1]);
  if (!m || !mk) throw new Error("Market not found");
  const sub = m[2];
  if (!sub) {
    return {
      market: mk,
      round,
      tradingOpen: true,
      headline: { yes: { source: "mid", priceBps: 420 }, no: { source: "mid", priceBps: 9580 } },
      volume: "0",
      confirmingFills: 0,
      bookFetchedAt: new Date().toISOString(),
    };
  }
  if (sub === "/book") return { market: mk.address, outcome: url.searchParams.get("outcome") ?? "yes", tradingOpen: true, fetchedAt: new Date().toISOString(), book: book(url.searchParams.get("outcome") === "no" ? 1 : 0) };
  if (sub === "/trades") return { market: mk.address, trades: [] };
  if (sub === "/chart") return { market: mk.address, trades: [], quotes: [], empty: true, indexing: false };
  throw new Error("Not found");
}
