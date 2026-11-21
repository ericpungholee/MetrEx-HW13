"use client";

// Portfolio (spec-v2 §10.5): available mUSD, YES/NO holdings per market, reserved balances, open
// orders, claimable redemptions and recent fills. P&L is not shown.
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { catalogByProperty, Outcome, PAYOUT_PER_SHARE } from "@metrex/exchange";
import {
  fetchBook,
  fetchHoldings,
  fetchLatestRound,
  fetchRound,
  fetchTrades,
  fetchWalletOrders,
  redemptionValue,
  reservedOf,
  TradeIndexingError,
  type RoundWithMarkets,
} from "@/lib/exchange-client";
import { formatPrice, formatShares, marketState, marketTitle, outcomeName, sideName } from "@/lib/exchange-format";
import { formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { PageHeader, Panel, Stat, TxLink } from "@/components/ui";
import { StateLabel, Unavailable } from "@/components/exchange/Labels";

// Multi-peril: one Open round per hazard, so look further back (docs/spec-multiperil.md §7.5).
const ROUNDS_BACK = 8n;

export default function PortfolioPage() {
  const { publicKey } = useWallet();
  const data = usePoll(
    async () => {
      if (!publicKey) return null;
      const latest = await fetchLatestRound();
      if (!latest) {
        return {
          rounds: [] as RoundWithMarkets[],
          holdings: null,
          orders: [],
          fills: [],
          indexing: false,
          premium: new Map<string, bigint>(),
          bids: new Map<string, number | null>(),
        };
      }
      const ids: bigint[] = [];
      for (let id = latest.roundId - 1n; id >= 0n && id > latest.roundId - ROUNDS_BACK; id--) ids.push(id);
      const older = await Promise.all(ids.map((id) => fetchRound(id)));
      const rounds: RoundWithMarkets[] = [latest, ...older.filter((r): r is RoundWithMarkets => r !== null)];
      const markets = rounds.flatMap((r) => r.markets);
      const [holdings, orders, trades] = await Promise.all([
        fetchHoldings(publicKey, markets),
        fetchWalletOrders(publicKey),
        Promise.all(
          markets.map((m) =>
            fetchTrades(m.address)
              .then((t) => t.map((x) => ({ ...x, market: m })))
              .catch((e: unknown) => {
                if (e instanceof TradeIndexingError) return null;
                throw e;
              }),
          ),
        ),
      ]);
      const indexing = trades.some((t) => t === null);
      const me = publicKey.toBase58();
      const mine = trades.flatMap((t) => t ?? []).filter((t) => t.buyer === me || t.seller === me);
      // Premium paid per market: YES bought minus YES sold, from indexed fills only (never estimated).
      const premium = new Map<string, bigint>();
      for (const t of mine) {
        if (t.outcome !== Outcome.Yes) continue;
        const sign = t.buyer === me ? 1n : -1n;
        premium.set(t.market.address, (premium.get(t.market.address) ?? 0n) + sign * t.quoteAmount);
      }
      // Value at the best YES bid (what the book would pay now), for unresolved markets where this wallet holds YES.
      const covered = markets.filter((m) => (holdings.yes.get(m.address) ?? 0n) > 0n && m.outcome === "unresolved");
      const bids = new Map(
        await Promise.all(covered.map(async (m) => [m.address, (await fetchBook(m.address).catch(() => null))?.yes.bestBidBps ?? null] as const)),
      );
      const fills = [...mine].sort((a, b) => b.slot - a.slot).slice(0, 20);
      return { rounds, holdings, orders, fills, indexing, premium, bids };
    },
    [publicKey?.toBase58()],
    6_000,
  );

  if (!publicKey) return <PageHeader title="Portfolio" description="Connect a wallet." />;
  if (!data.data) return data.error ? <Unavailable>Portfolio unavailable: {data.error}</Unavailable> : <div className="h-96 animate-pulse bg-bg-soft" />;
  const { rounds, holdings, orders, fills, indexing, premium, bids } = data.data;
  const reserved = reservedOf(orders);
  const me = publicKey.toBase58();

  const rows = rounds.flatMap((r) =>
    r.markets.map((m) => {
      const yes = holdings?.yes.get(m.address) ?? 0n;
      const no = holdings?.no.get(m.address) ?? 0n;
      const res = reservedOf(orders, m.address);
      return { r, m, yes, no, res, claim: redemptionValue(m.outcome, yes + res.yes, no + res.no) };
    }),
  );
  const held = rows.filter((x) => x.yes > 0n || x.no > 0n || x.res.musd > 0n || x.res.yes > 0n || x.res.no > 0n);
  const claimable = rows.reduce((a, x) => a + x.claim, 0n);

  return (
    <div className="space-y-8">
      <PageHeader title="Portfolio" />
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="mUSD available" large>
          {holdings ? formatMusd(holdings.musd) : "—"}
        </Stat>
        <Stat label="mUSD reserved in bids" large>
          {formatMusd(reserved.musd)}
        </Stat>
        <Stat label="Claimable redemptions" large>
          {formatMusd(claimable)}
        </Stat>
        <Stat label="Open orders" large>
          {orders.length}
        </Stat>
      </div>

      <Panel title="Coverage" right="YES shares held; one share pays $1 if the trigger is met">
        {held.every((x) => x.yes + x.res.yes === 0n) ? (
          <div className="text-sm text-dim">No coverage held. Buy YES on a property market to hold protection for that month.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-faint">
              <tr>
                <th className="pb-2 font-medium">Property</th>
                <th className="pb-2 font-medium">Contract</th>
                <th className="pb-2 text-right font-medium">Coverage</th>
                <th className="pb-2 text-right font-medium">Premium paid</th>
                <th className="pb-2 text-right font-medium">Value at best bid</th>
                <th className="pb-2 pl-4 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {held
                .filter((x) => x.yes + x.res.yes > 0n)
                .map(({ r, m, yes, res }) => {
                  const c = catalogByProperty(m.propertyId);
                  const shares = yes + res.yes;
                  const bid = bids.get(m.address) ?? null;
                  const paid = premium.get(m.address);
                  return (
                    <tr key={m.address} className="border-t border-line">
                      <td className="py-2.5">
                        <Link className="font-medium hover:underline" href={`/market/${m.address}`}>
                          {marketTitle(m)}
                        </Link>
                        {c && <div className="text-xs text-faint">{c.place}</div>}
                      </td>
                      <td className="py-2.5 text-dim">
                        {c ? `${c.month} (replay)` : "—"}
                        <div className="text-xs text-faint">{r.state === "open" ? "trading open" : "trading closed"}</div>
                      </td>
                      <td className="num py-2.5 text-right">${formatMusd(shares * PAYOUT_PER_SHARE, 0)}</td>
                      <td className="num py-2.5 text-right">{paid === undefined ? (indexing ? "indexing…" : "—") : `$${formatMusd(paid)}`}</td>
                      <td className="num py-2.5 text-right">
                        {m.outcome !== "unresolved" ? "—" : bid === null ? "no bids" : `$${formatMusd(shares * BigInt(bid) * 100n)}`}
                      </td>
                      <td className="py-2.5 pl-4">
                        <StateLabel state={marketState(m.outcome, r)} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-dim">
          Value at best bid is what the current book would pay for these shares, not a forecast. A price change does not change the payout of shares
          you already hold.
        </p>
      </Panel>

      <Panel title="Positions">
        {held.length === 0 ? (
          <div className="text-sm text-dim">No shares or resting orders in the latest rounds.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-faint">
              <tr>
                <th className="pb-2 font-medium">Market</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 text-right font-medium">YES</th>
                <th className="pb-2 text-right font-medium">NO</th>
                <th className="pb-2 text-right font-medium">Reserved</th>
                <th className="pb-2 text-right font-medium">Redeemable</th>
              </tr>
            </thead>
            <tbody>
              {held.map(({ r, m, yes, no, res, claim }) => (
                <tr key={m.address} className="border-t border-line">
                  <td className="py-2.5">
                    <Link className="font-medium hover:underline" href={`/market/${m.address}`}>
                      {marketTitle(m)}
                    </Link>{" "}
                    <span className="text-faint">round #{r.roundId.toString()}</span>
                  </td>
                  <td className="py-2.5">
                    <StateLabel state={marketState(m.outcome, r)} />
                  </td>
                  <td className="num py-2.5 text-right">{formatShares(yes)}</td>
                  <td className="num py-2.5 text-right">{formatShares(no)}</td>
                  <td className="num py-2.5 text-right text-dim">
                    {res.musd ? `${formatMusd(res.musd)} mUSD` : ""}
                    {res.yes ? ` ${formatShares(res.yes)} YES` : ""}
                    {res.no ? ` ${formatShares(res.no)} NO` : ""}
                    {!res.musd && !res.yes && !res.no ? "—" : ""}
                  </td>
                  <td className="num py-2.5 text-right">{claim > 0n ? `${formatMusd(claim)} mUSD` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {claimable > 0n && <p className="mt-2 text-xs text-faint">Redeem on each market page.</p>}
      </Panel>

      <Panel title="Open orders">
        {orders.length === 0 ? (
          <div className="text-sm text-dim">No open orders.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {orders.map((o) => {
                const m = rows.find((x) => x.m.address === o.market)?.m;
                return (
                  <tr key={o.address} className="border-t border-line">
                    <td className="py-2.5">
                      {m ? (
                        <Link className="hover:underline" href={`/market/${o.market}`}>
                          {marketTitle(m)}
                        </Link>
                      ) : (
                        o.market.slice(0, 8)
                      )}
                    </td>
                    <td className="py-2.5">
                      {sideName(o.side)} {outcomeName(o.outcome)} @ <span className="num">{formatPrice(o.priceBps)}</span>
                    </td>
                    <td className="num py-2.5 text-right text-dim">
                      {formatShares(o.remainingQty)} of {formatShares(o.originalQty)} resting{!o.tradingOpen ? " · awaiting sweep" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Recent fills" right="from finalized and confirming events">
        {indexing && <div className="mb-2 text-xs text-warn">Trade history is still being indexed; some fills may not be listed yet.</div>}
        {fills.length === 0 ? (
          indexing ? null : <div className="text-sm text-dim">No fills yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {fills.map((t) => (
                <tr key={`${t.signature}-${t.quantity}-${t.priceBps}`} className="border-t border-line">
                  <td className="py-2.5">
                    {t.buyer === me ? "Bought" : "Sold"} {formatShares(t.quantity)} {outcomeName(t.outcome)} · {marketTitle(t.market)}
                  </td>
                  <td className="num py-2.5 text-right">{formatPrice(t.priceBps)}</td>
                  <td className="num py-2.5 text-right">{formatMusd(t.quoteAmount)} mUSD</td>
                  <td className="py-2.5 text-right">
                    {!t.finalized && <span className="mr-2 text-xs text-warn">confirming</span>}
                    <TxLink signature={t.signature} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
