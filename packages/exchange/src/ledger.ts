// Trade and settlement ledger (docs/spec-simulation.md §8). Policy and display code, not frozen.
// Pure: rebuilt from a market's finalized program events only (OrderFilled, SharesSplit,
// SharesMerged, SharesRedeemed) plus the market account and the vault balance. Nothing here comes
// from the simulator. All amounts are bigint base units; shares have 0 decimals.
//
// Cash conservation: fills move mUSD between wallets, so only split (in), merge and redeem (out)
// touch the vault. Booked collateral = splits − merges − payouts, and the vault must hold at least
// that and at least every outstanding entitlement (spec-v2 §4.6: balance ≥ obligation, never equality).

import { INVALID_PAYOUT_PER_SHARE, Outcome, PAYOUT_PER_SHARE } from "./constants";

export type MarketOutcome = "unresolved" | "yes" | "no" | "invalid";

interface Pos {
  signature: string;
  blockTime: number | null;
}

export type LedgerEvent =
  | (Pos & { kind: "fill"; outcome: number; buyer: string; seller: string; quantity: bigint; priceBps: number; quoteAmount: bigint })
  | (Pos & { kind: "split"; holder: string; quantity: bigint; amount: bigint })
  | (Pos & { kind: "merge"; holder: string; quantity: bigint; amount: bigint })
  | (Pos & { kind: "redeem"; holder: string; outcome: number; quantity: bigint; payout: bigint });

export interface TradeRow {
  signature: string;
  blockTime: number | null;
  outcome: "YES" | "NO";
  buyer: string;
  seller: string;
  quantity: bigint;
  priceBps: number;
  quoteAmount: bigint;
}

export interface ParticipantRow {
  wallet: string;
  /** Net shares still held (free or in sell escrow), after redemptions. */
  yes: bigint;
  no: bigint;
  /** mUSD paid for share purchases and splits. */
  spent: bigint;
  /** mUSD received from share sales and merges (not payouts). */
  received: bigint;
  /** mUSD already paid out by redemption. */
  redeemed: bigint;
  /** mUSD still claimable on unredeemed winning shares (0 until resolution). */
  claimable: bigint;
  /** received + redeemed + claimable − spent; null while unresolved. */
  netPnl: bigint | null;
  trades: number;
  redemptions: string[];
}

export interface SettlementLedger {
  outcome: MarketOutcome;
  trades: TradeRow[];
  participants: ParticipantRow[];
  totals: {
    volume: bigint;
    trades: number;
    participants: number;
    splits: bigint;
    merges: bigint;
    payouts: bigint;
    /** splits − merges − payouts: what the vault must hold from booked flows. */
    bookedCollateral: bigint;
    claimable: bigint;
    /** Σ net P&L over all wallets; 0 after resolution once every claim is counted (zero-sum, no fees). */
    pnlSum: bigint | null;
  };
  reconciliation: {
    vaultBalance: bigint;
    pairsOutstanding: bigint;
    /** vault ≥ booked collateral. */
    vaultCoversBooked: boolean;
    /** vault ≥ every outstanding claim. */
    vaultCoversClaims: boolean;
    /** Payouts never exceeded collateral ever deposited. */
    payoutsWithinDeposits: boolean;
    /** Unsolicited tokens in the vault beyond booked collateral (stays stranded, spec-v2 §4.6). */
    surplus: bigint;
  };
}

const payoutPerShare = (outcome: MarketOutcome, side: "yes" | "no"): bigint => {
  if (outcome === "invalid") return INVALID_PAYOUT_PER_SHARE;
  if (outcome === side) return PAYOUT_PER_SHARE;
  return 0n;
};

export function buildLedger(
  events: readonly LedgerEvent[],
  market: { outcome: MarketOutcome; pairsOutstanding: bigint; vaultBalance: bigint },
): SettlementLedger {
  const rows = new Map<string, ParticipantRow>();
  const row = (w: string): ParticipantRow => {
    let r = rows.get(w);
    if (!r) {
      r = { wallet: w, yes: 0n, no: 0n, spent: 0n, received: 0n, redeemed: 0n, claimable: 0n, netPnl: null, trades: 0, redemptions: [] };
      rows.set(w, r);
    }
    return r;
  };
  const trades: TradeRow[] = [];
  let volume = 0n;
  let splits = 0n;
  let merges = 0n;
  let payouts = 0n;
  for (const e of events) {
    switch (e.kind) {
      case "fill": {
        const yes = e.outcome === Outcome.Yes;
        const b = row(e.buyer);
        const s = row(e.seller);
        if (yes) {
          b.yes += e.quantity;
          s.yes -= e.quantity;
        } else {
          b.no += e.quantity;
          s.no -= e.quantity;
        }
        b.spent += e.quoteAmount;
        s.received += e.quoteAmount;
        b.trades++;
        s.trades++;
        volume += e.quoteAmount;
        trades.push({ signature: e.signature, blockTime: e.blockTime, outcome: yes ? "YES" : "NO", buyer: e.buyer, seller: e.seller, quantity: e.quantity, priceBps: e.priceBps, quoteAmount: e.quoteAmount });
        break;
      }
      case "split": {
        const r = row(e.holder);
        r.yes += e.quantity;
        r.no += e.quantity;
        r.spent += e.amount;
        splits += e.amount;
        break;
      }
      case "merge": {
        const r = row(e.holder);
        r.yes -= e.quantity;
        r.no -= e.quantity;
        r.received += e.amount;
        merges += e.amount;
        break;
      }
      case "redeem": {
        const r = row(e.holder);
        if (e.outcome === Outcome.Yes) r.yes -= e.quantity;
        else r.no -= e.quantity;
        r.redeemed += e.payout;
        r.redemptions.push(e.signature);
        payouts += e.payout;
        break;
      }
    }
  }
  const resolved = market.outcome !== "unresolved";
  let claimable = 0n;
  let pnlSum: bigint | null = resolved ? 0n : null;
  for (const r of rows.values()) {
    if (resolved) {
      r.claimable = r.yes * payoutPerShare(market.outcome, "yes") + r.no * payoutPerShare(market.outcome, "no");
      r.netPnl = r.received + r.redeemed + r.claimable - r.spent;
      claimable += r.claimable;
      pnlSum = (pnlSum ?? 0n) + r.netPnl;
    }
  }
  const participants = [...rows.values()].sort((a, b) => {
    const pa = a.netPnl ?? a.received - a.spent;
    const pb = b.netPnl ?? b.received - b.spent;
    return pa > pb ? -1 : pa < pb ? 1 : a.wallet < b.wallet ? -1 : 1;
  });
  const booked = splits - merges - payouts;
  return {
    outcome: market.outcome,
    trades: trades.reverse(),
    participants,
    totals: { volume, trades: trades.length, participants: participants.filter((p) => p.trades > 0 || p.spent > 0n).length, splits, merges, payouts, bookedCollateral: booked, claimable, pnlSum },
    reconciliation: {
      vaultBalance: market.vaultBalance,
      pairsOutstanding: market.pairsOutstanding,
      vaultCoversBooked: market.vaultBalance >= booked,
      vaultCoversClaims: market.vaultBalance >= claimable,
      payoutsWithinDeposits: payouts <= splits - merges,
      surplus: market.vaultBalance > booked ? market.vaultBalance - booked : 0n,
    },
  };
}
