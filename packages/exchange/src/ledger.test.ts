// Settlement ledger from events (docs/spec-simulation.md §8).
import { describe, expect, it } from "vitest";
import { MUSD_UNIT, Outcome } from "./constants";
import { buildLedger, type LedgerEvent } from "./ledger";
import { quote } from "./math";

const at = (n: number) => ({ signature: `sig${n}`, blockTime: n });
const split = (n: number, holder: string, q: bigint): LedgerEvent => ({ ...at(n), kind: "split", holder, quantity: q, amount: q * MUSD_UNIT });
const fill = (n: number, outcome: number, buyer: string, seller: string, q: bigint, p: number): LedgerEvent => ({ ...at(n), kind: "fill", outcome, buyer, seller, quantity: q, priceBps: p, quoteAmount: quote(q, p) });

// A maker splits 1,000 pairs, sells 600 YES to a homeowner at 80 bps and 400 NO to an investor at 9,900 bps.
const events: LedgerEvent[] = [
  split(1, "maker", 1_000n),
  fill(2, Outcome.Yes, "home", "maker", 600n, 80),
  fill(3, Outcome.No, "inv", "maker", 400n, 9_900),
];

describe("settlement ledger", () => {
  it("unresolved: positions, volume, booked collateral; no P&L yet", () => {
    const l = buildLedger(events, { outcome: "unresolved", pairsOutstanding: 1_000n, vaultBalance: 1_000n * MUSD_UNIT });
    expect(l.totals.volume).toBe(quote(600n, 80) + quote(400n, 9_900));
    expect(l.totals.trades).toBe(2);
    expect(l.totals.participants).toBe(3);
    expect(l.totals.bookedCollateral).toBe(1_000n * MUSD_UNIT);
    const maker = l.participants.find((p) => p.wallet === "maker")!;
    expect([maker.yes, maker.no]).toEqual([400n, 600n]);
    expect(maker.netPnl).toBeNull();
    expect(l.reconciliation.vaultCoversBooked).toBe(true);
  });

  it("resolved YES with a redemption: payouts, claims, zero-sum P&L, vault reconciliation", () => {
    const redeemed: LedgerEvent[] = [...events, { ...at(4), kind: "redeem", holder: "home", outcome: Outcome.Yes, quantity: 600n, payout: 600n * MUSD_UNIT }];
    const l = buildLedger(redeemed, { outcome: "yes", pairsOutstanding: 400n, vaultBalance: 400n * MUSD_UNIT });
    const home = l.participants.find((p) => p.wallet === "home")!;
    expect(home.redeemed).toBe(600n * MUSD_UNIT);
    expect(home.netPnl).toBe(600n * MUSD_UNIT - quote(600n, 80));
    expect(home.redemptions).toEqual(["sig4"]);
    const maker = l.participants.find((p) => p.wallet === "maker")!;
    expect(maker.claimable).toBe(400n * MUSD_UNIT);
    expect(l.participants.find((p) => p.wallet === "inv")!.netPnl).toBe(-quote(400n, 9_900));
    expect(l.totals.pnlSum).toBe(0n);
    expect(l.totals.claimable).toBe(400n * MUSD_UNIT);
    expect(l.reconciliation).toMatchObject({ vaultCoversBooked: true, vaultCoversClaims: true, payoutsWithinDeposits: true, surplus: 0n });
  });

  it("Invalid pays half per share on both sides, still zero-sum", () => {
    const l = buildLedger(events, { outcome: "invalid", pairsOutstanding: 1_000n, vaultBalance: 1_000n * MUSD_UNIT });
    expect(l.totals.claimable).toBe(1_000n * MUSD_UNIT);
    expect(l.totals.pnlSum).toBe(0n);
  });

  it("an underfunded vault is flagged, unsolicited surplus is reported", () => {
    expect(buildLedger(events, { outcome: "no", pairsOutstanding: 1_000n, vaultBalance: 10n }).reconciliation.vaultCoversClaims).toBe(false);
    expect(buildLedger(events, { outcome: "no", pairsOutstanding: 1_000n, vaultBalance: 1_005n * MUSD_UNIT }).reconciliation.surplus).toBe(5n * MUSD_UNIT);
  });
});
