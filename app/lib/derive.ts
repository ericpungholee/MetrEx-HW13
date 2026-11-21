// Pure derivations over on-chain account state (no network). Amounts are bigint.
import {
  decodeLabel,
  marketDisplayState,
  marketStatusOf,
  offerStatusOf,
  type ListingAccount,
  type MarketAccount,
  type MarketDisplayState,
  type OfferAccount,
  type PropertyAccount,
} from "@metrex/shared";
import { PublicKey } from "@solana/web3.js";
import { toBig } from "./format";
import type { Keyed } from "./types";

export interface MarketSummary {
  market: Keyed<MarketAccount>;
  label: string;
  display: MarketDisplayState;
  target: bigint;
  activated: bigint;
  remaining: bigint;
  openOffers: Keyed<OfferAccount>[];
  acceptedOffers: Keyed<OfferAccount>[];
  bestOpenBps: number | null;
  premiumTotal: bigint;
  collateralTotal: bigint;
}

export function propertyLabel(
  propertyId: number,
  properties: Keyed<PropertyAccount>[] | null | undefined,
): string {
  const p = properties?.find((x) => x.account.propertyId === propertyId);
  return p ? decodeLabel(p.account.label) : `Property #${propertyId}`;
}

export function summarizeMarket(
  market: Keyed<MarketAccount>,
  offers: Keyed<OfferAccount>[],
  properties?: Keyed<PropertyAccount>[] | null,
): MarketSummary {
  const mine = offers.filter((o) => o.account.market.equals(market.publicKey));
  const openOffers = mine
    .filter((o) => offerStatusOf(o.account.status) === "open")
    .sort((a, b) => a.account.premiumBps - b.account.premiumBps || a.account.createdAt.cmp(b.account.createdAt));
  const acceptedOffers = mine.filter((o) => {
    const s = offerStatusOf(o.account.status);
    return s === "accepted" || s === "claimed" || s === "refunded";
  });
  const target = toBig(market.account.coverageTarget);
  const activated = toBig(market.account.coverageActivated);
  return {
    market,
    label: propertyLabel(market.account.propertyId, properties),
    display: marketDisplayState(market.account),
    target,
    activated,
    remaining: target > activated ? target - activated : 0n,
    openOffers,
    acceptedOffers,
    bestOpenBps: openOffers[0]?.account.premiumBps ?? null,
    premiumTotal: acceptedOffers.reduce((s, o) => s + toBig(o.account.premium), 0n),
    collateralTotal: acceptedOffers.reduce((s, o) => s + toBig(o.account.collateral), 0n),
  };
}

export const isDefaultKey = (k: PublicKey) => k.equals(PublicKey.default);

// ---------------------------------------------------------------------------
// Portfolio (spec §3.1 item 4, §10.4)
// ---------------------------------------------------------------------------

export interface PositionRow {
  market: Keyed<MarketAccount>;
  offer: Keyed<OfferAccount>;
  side: "Protection" | "Risk";
  /** Held side was bought on the secondary market (not the original party). */
  bought: boolean;
  /** Vault coverage C: paid to this side if it wins. */
  payoutIfWin: bigint;
  status: "active" | "claimable" | "lost" | "claimed" | "refunded" | "voided";
  /** Realized P&L in base units for resolved positions held by the original party; null if unknown. */
  realized: bigint | null;
}

export interface Portfolio {
  openOffers: { market: Keyed<MarketAccount> | undefined; offer: Keyed<OfferAccount> }[];
  lockedCollateral: bigint;
  positions: PositionRow[];
  /** Risk-side coverage payable if the fire triggered, over unresolved markets. */
  totalExposure: bigint;
  exposureByScenario: Map<number, { risk: bigint; protection: bigint; positions: number }>;
  premiumsEarned: bigint;
  premiumsPaid: bigint;
  claimable: bigint;
  realizedPnl: bigint;
  bought: PositionRow[];
}

/** Listing on a given offer+side, if any. */
export function listingFor(
  listings: Keyed<ListingAccount>[],
  offer: PublicKey,
  side: number,
): Keyed<ListingAccount> | undefined {
  return listings.find((l) => l.account.offer.equals(offer) && l.account.side === side);
}

export function computePortfolio(
  me: PublicKey,
  markets: Keyed<MarketAccount>[],
  offers: Keyed<OfferAccount>[],
): Portfolio {
  const marketByKey = new Map(markets.map((m) => [m.publicKey.toBase58(), m]));
  const openOffers: Portfolio["openOffers"] = [];
  const positions: PositionRow[] = [];
  let lockedCollateral = 0n;
  let premiumsEarned = 0n;
  let premiumsPaid = 0n;

  for (const o of offers) {
    const a = o.account;
    const st = offerStatusOf(a.status);
    const market = marketByKey.get(a.market.toBase58());
    if (st === "open" && a.underwriter.equals(me)) {
      openOffers.push({ market, offer: o });
      lockedCollateral += toBig(a.collateral);
      continue;
    }
    if (st !== "accepted" && st !== "claimed" && st !== "refunded") continue;
    if (!market) continue;

    // Premiums by original party (P moved homeowner → vault at acceptance).
    if (a.underwriter.equals(me) && st !== "refunded") premiumsEarned += toBig(a.premium);
    if (market.account.homeowner.equals(me) && st !== "refunded") premiumsPaid += toBig(a.premium);

    const ms = marketStatusOf(market.account.status);
    for (const side of ["Protection", "Risk"] as const) {
      const holder = side === "Protection" ? a.protectionHolder : a.riskHolder;
      if (!holder.equals(me)) continue;
      const original = side === "Protection" ? market.account.homeowner : a.underwriter;
      const bought = !original.equals(me);
      const wins = (side === "Protection" && ms === "resolvedYes") || (side === "Risk" && ms === "resolvedNo");
      const resolved = ms === "resolvedYes" || ms === "resolvedNo";
      let status: PositionRow["status"];
      if (st === "refunded") status = "refunded";
      else if (ms === "voided") status = "voided";
      else if (!resolved) status = "active";
      else if (!wins) status = "lost";
      else status = st === "claimed" ? "claimed" : "claimable";

      // Original party's P&L: protection pays P, gets C on YES; risk posts K, gets C on NO.
      let realized: bigint | null = null;
      if (resolved && !bought) {
        const C = toBig(a.coverage);
        const P = toBig(a.premium);
        const K = toBig(a.collateral);
        realized = side === "Protection" ? (wins ? C - P : -P) : wins ? P : -K;
      }
      positions.push({ market, offer: o, side, bought, payoutIfWin: toBig(a.coverage), status, realized });
    }
  }

  const exposureByScenario: Portfolio["exposureByScenario"] = new Map();
  let totalExposure = 0n;
  let claimable = 0n;
  let realizedPnl = 0n;
  for (const p of positions) {
    if (p.status === "claimable") claimable += p.payoutIfWin;
    if (p.realized !== null) realizedPnl += p.realized;
    if (p.status !== "active") continue;
    const sid = p.market.account.scenarioId;
    const e = exposureByScenario.get(sid) ?? { risk: 0n, protection: 0n, positions: 0 };
    if (p.side === "Risk") {
      e.risk += p.payoutIfWin;
      totalExposure += p.payoutIfWin;
    } else {
      e.protection += p.payoutIfWin;
    }
    e.positions += 1;
    exposureByScenario.set(sid, e);
  }

  return {
    openOffers,
    lockedCollateral,
    positions,
    totalExposure,
    exposureByScenario,
    premiumsEarned,
    premiumsPaid,
    claimable,
    realizedPnl,
    bought: positions.filter((p) => p.bought),
  };
}
