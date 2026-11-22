// Shared helpers for the v2 scripts. Pure where possible; never prints secrets.

import { PublicKey } from "@solana/web3.js";
import { BPS_DENOMINATOR, DEMO_BOTS, Outcome, crossedPairs, outcomeBook, type BookOrder, type BotParams } from "@metrex/exchange";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function isLoopback(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** ProgramData: [u32 tag=3][u64 slot][Option<Pubkey>]. */
export function upgradeAuthorityOf(data: Uint8Array): PublicKey | null | "invalid" {
  if (data.length < 13) return "invalid";
  if (new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) !== 3) return "invalid";
  if (data[12] === 0) return null;
  return new PublicKey(data.subarray(13, 45));
}

/** `{ A: <base58>, B: …, C: … }` → maker → bot name. */
export type BotMakers = Record<string, string>;

/**
 * §8.3 depth guarantee on the featured market at zero inventory: the exact shipped YES ladder
 * (bids C 100 @ 410, B 150 @ 400, A 200 @ 370; asks A 200 @ 430, B 150 @ 500, C 100 @ 590), each level
 * a single bot order, and the NO book quoted at the exact complements. Returns the failures.
 * With a catalog `ladder` (docs/spec-multiperil.md §6) it checks that ladder's exact levels instead,
 * and the 410/300 presenter-script checks apply only to the shipped DEMO_BOTS ladder.
 */
export function checkDepthGuarantee(book: readonly BookOrder[], bots: BotMakers, ladder: readonly BotParams[] = DEMO_BOTS): string[] {
  const bad: string[] = [];
  const name = (maker: string) => bots[maker] ?? "user";
  const want = (outcome: 0 | 1) => {
    const bids = ladder.map((p) => ({ bot: p.name, price: p.refBps - p.halfSpreadBps, size: p.topSize }));
    const asks = ladder.map((p) => ({ bot: p.name, price: p.refBps + p.halfSpreadBps, size: p.topSize }));
    if (outcome === Outcome.Yes) return { bids, asks };
    return {
      bids: asks.map((a) => ({ ...a, price: BPS_DENOMINATOR - a.price })),
      asks: bids.map((b) => ({ ...b, price: BPS_DENOMINATOR - b.price })),
    };
  };
  for (const outcome of [Outcome.Yes, Outcome.No] as const) {
    const label = outcome === Outcome.Yes ? "YES" : "NO";
    const b = outcomeBook(book, outcome);
    const w = want(outcome);
    const sortBids = [...w.bids].sort((x, y) => y.price - x.price);
    const sortAsks = [...w.asks].sort((x, y) => x.price - y.price);
    const got = (ls: typeof b.bids) => ls.map((l) => `${l.orders.map((o) => name(o.maker)).join("+")} ${l.quantity}@${l.priceBps}`);
    const exp = (ls: typeof sortBids) => ls.map((l) => `${l.bot} ${l.size}@${l.price}`);
    if (JSON.stringify(got(b.bids)) !== JSON.stringify(exp(sortBids))) bad.push(`${label} bids ${JSON.stringify(got(b.bids))} ≠ ${JSON.stringify(exp(sortBids))}`);
    if (JSON.stringify(got(b.asks)) !== JSON.stringify(exp(sortAsks))) bad.push(`${label} asks ${JSON.stringify(got(b.asks))} ≠ ${JSON.stringify(exp(sortAsks))}`);
    if (crossedPairs(book, outcome).length) bad.push(`${label} book is crossed`);
  }
  if (ladder !== DEMO_BOTS) return bad;
  const yes = outcomeBook(book, Outcome.Yes);
  const atOrAbove410 = yes.bids.filter((l) => l.priceBps >= 410).reduce((a, l) => a + l.quantity, 0n);
  if (atOrAbove410 !== 100n) bad.push(`YES depth at ≥ 410 is ${atOrAbove410}, the partial fill needs exactly 100`);
  const topTwoAsks = yes.asks.slice(0, 2).reduce((a, l) => a + l.quantity, 0n);
  if (topTwoAsks < 300n) bad.push(`top two YES ask levels hold ${topTwoAsks} < 300`);
  return bad;
}

/**
 * Live-demo readiness (docs/spec-simulation.md §3): each side of each book quoted by at least one
 * maker and no crosses. Adaptive makers legitimately pull a side while their inventory is one-sided,
 * so a running demo does not require every maker on every side.
 */
export function checkBooksQuoted(book: readonly BookOrder[], bots: BotMakers): string[] {
  const bad: string[] = [];
  for (const outcome of [Outcome.Yes, Outcome.No] as const) {
    for (const side of [0, 1] as const) {
      if (!book.some((o) => o.maker in bots && o.outcome === outcome && o.side === side)) bad.push(`no maker ${outcome === 0 ? "YES" : "NO"} ${side === 0 ? "bid" : "ask"}`);
    }
    if (crossedPairs(book, outcome).length) bad.push(`${outcome === 0 ? "YES" : "NO"} book is crossed`);
  }
  return bad;
}

/** Both books of a market quoted by every bot on both sides, and no crosses. */
export function checkBotsQuoting(book: readonly BookOrder[], bots: BotMakers): string[] {
  const bad: string[] = [];
  for (const outcome of [Outcome.Yes, Outcome.No] as const) {
    for (const side of [0, 1] as const) {
      for (const [maker, n] of Object.entries(bots)) {
        if (!book.some((o) => o.maker === maker && o.outcome === outcome && o.side === side)) bad.push(`bot ${n} missing ${outcome === 0 ? "YES" : "NO"} ${side === 0 ? "bid" : "ask"}`);
      }
    }
    if (crossedPairs(book, outcome).length) bad.push(`${outcome === 0 ? "YES" : "NO"} book is crossed`);
  }
  return bad;
}
