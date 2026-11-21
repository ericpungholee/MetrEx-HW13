// assertMarketInvariants (spec-v2 §13.1): I1 collateral backing (§4.6), I2 mint configuration and
// I3 order escrow backing (§5.2), I5 mUSD conservation and I11 (closed orders leave no accounts),
// checked after every state-changing call.
import type { Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
import { expect } from "chai";
import { INVALID_PAYOUT_PER_SHARE, OrderSide, PAYOUT_PER_SHARE, quote } from "@metrex/exchange";
import type { MetrexExchange } from "../../target/types/metrex_exchange";

export interface TrackedMarket {
  label: string;
  round: PublicKey;
  propertyId: number;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  /**
   * Set once the test sends unsolicited mUSD to the vault or a holder self-burns shares.
   * Clean markets must satisfy §4.6 with equality, dirty ones with `≥` only.
   */
  dirty: boolean;
}

export interface TrackedOrder {
  label: string;
  market: PublicKey;
  order: PublicKey;
  escrow: PublicKey;
  maker: PublicKey;
  outcome: number;
  side: number;
  priceBps: number;
  /** False once cancelled or swept: both accounts must then be gone (I11). */
  open: boolean;
  /** Set once the test sends unsolicited tokens to the escrow (I3 then holds at `≥`). */
  dirty: boolean;
}

/** Every mUSD account the tests know about, every order, and the mUSD the test faucet minted. */
export interface MusdLedger {
  accounts: PublicKey[];
  orders: TrackedOrder[];
  minted: bigint;
}

export type OutcomeName = "unresolved" | "yes" | "no" | "invalid";

export const outcomeName = (o: object): OutcomeName => Object.keys(o)[0] as OutcomeName;

export function makeInvariantChecker(
  program: Program<MetrexExchange>,
  conn: Connection,
  ledger: MusdLedger,
) {
  const amount = async (a: PublicKey): Promise<bigint> => (await getAccount(conn, a, "confirmed")).amount;

  /** I5: total mUSD across wallets, vaults and BUY escrows equals what the faucet minted. */
  async function assertConservation(): Promise<void> {
    const buyEscrows = ledger.orders.filter((o) => o.open && o.side === OrderSide.Buy).map((o) => o.escrow);
    const balances = await Promise.all([...ledger.accounts, ...buyEscrows].map(amount));
    const total = balances.reduce((s, b) => s + b, 0n);
    expect(total, "I5 mUSD conservation").to.equal(ledger.minted);
  }

  /** I3 for open orders of a market; I11 (no Order, no escrow) for closed ones. */
  async function assertOrderInvariants(market: PublicKey): Promise<void> {
    for (const o of ledger.orders.filter((x) => x.market.equals(market))) {
      if (!o.open) {
        const [oi, ei] = await conn.getMultipleAccountsInfo([o.order, o.escrow], "confirmed");
        expect(oi, `I11 ${o.label} order closed`).to.equal(null);
        expect(ei, `I11 ${o.label} escrow closed`).to.equal(null);
        continue;
      }
      const [acct, esc] = await Promise.all([program.account.order.fetch(o.order, "confirmed"), amount(o.escrow)]);
      const remaining = BigInt(acct.remainingQty.toString());
      expect(remaining <= BigInt(acct.originalQty.toString()), `${o.label} remaining ≤ original`).to.equal(true);
      expect(acct.market.toBase58()).to.equal(market.toBase58());
      const reserve = o.side === OrderSide.Buy ? quote(remaining, o.priceBps) : remaining;
      expect(esc >= reserve, `I3 ${o.label} escrow ${esc} ≥ reserve ${reserve}`).to.equal(true);
      if (!o.dirty) expect(esc, `I3 ${o.label} clean escrow`).to.equal(reserve);
    }
  }

  /** I1 + I2 for one market, then I5 globally. */
  async function assertMarketInvariants(mk: TrackedMarket): Promise<void> {
    const [acct, vault, yes, no] = await Promise.all([
      program.account.market.fetch(mk.market, "confirmed"),
      amount(mk.vault),
      getMint(conn, mk.yesMint, "confirmed"),
      getMint(conn, mk.noMint, "confirmed"),
    ]);
    const pairs = BigInt(acct.pairsOutstanding.toString());
    const ys = yes.supply;
    const ns = no.supply;

    // I2: 0 decimals, market PDA is the sole mint authority, no freeze authority.
    for (const mint of [yes, no]) {
      expect(mint.decimals, "I2 decimals").to.equal(0);
      expect(mint.mintAuthority?.toBase58(), "I2 mint authority").to.equal(mk.market.toBase58());
      expect(mint.freezeAuthority, "I2 freeze authority").to.equal(null);
    }
    expect(acct.vault.toBase58()).to.equal(mk.vault.toBase58());

    // I1 (§4.6): booked obligation, `≥` always, `=` for clean markets.
    let obligation: bigint;
    const outcome = outcomeName(acct.outcome);
    switch (outcome) {
      case "unresolved":
        obligation = pairs * PAYOUT_PER_SHARE;
        expect(ys <= pairs, `I1 ${mk.label} yes_supply ${ys} ≤ pairs ${pairs}`).to.equal(true);
        expect(ns <= pairs, `I1 ${mk.label} no_supply ${ns} ≤ pairs ${pairs}`).to.equal(true);
        if (!mk.dirty) {
          expect(ys, "clean yes supply").to.equal(pairs);
          expect(ns, "clean no supply").to.equal(pairs);
        }
        break;
      case "yes":
        obligation = ys * PAYOUT_PER_SHARE;
        break;
      case "no":
        obligation = ns * PAYOUT_PER_SHARE;
        break;
      case "invalid":
        obligation = (ys + ns) * INVALID_PAYOUT_PER_SHARE;
        break;
    }
    expect(vault >= obligation, `I1 ${mk.label} vault ${vault} ≥ obligation ${obligation}`).to.equal(true);
    if (!mk.dirty) expect(vault, `I1 ${mk.label} clean vault`).to.equal(obligation);

    await assertOrderInvariants(mk.market);
    await assertConservation();
  }

  return { assertMarketInvariants, assertConservation };
}
