"use client";

// Portfolio (spec-v2 §10.5): available mUSD, YES/NO holdings per market, reserved balances, open
// orders, claimable redemptions and recent fills. P&L is not shown.
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { catalogByProperty, OrderSide, Outcome, PAYOUT_PER_SHARE } from "@metrex/exchange";
import {
  bookOrders,
  fetchBook,
  fetchAllRounds,
  fetchHoldings,
  fetchTrades,
  fetchWalletOrders,
  previewTrade,
  redemptionValue,
  reservedOf,
  TradeIndexingError,
} from "@/lib/exchange-client";
import { formatPrice, formatShares, marketState, marketTitle, outcomeName, sideName } from "@/lib/exchange-format";
import { formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { PageHeader, Panel, Stat, TxLink } from "@/components/ui";
import { StateLabel, Unavailable } from "@/components/exchange/Labels";

export default function PortfolioPage() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  if (publicKey) return <ConnectedPortfolio key={publicKey.toBase58()} publicKey={publicKey} />;
  return (
    <div className="space-y-6">
      <PageHeader title="Portfolio" />
      <section className="space-y-3 rounded-md border border-line px-5 py-6">
        <h2 className="text-lg font-semibold">Connect a wallet to view your portfolio</h2>
        <p className="text-sm text-dim">See your coverage, open orders and claimable payouts.</p>
        <button type="button" className="btn btn-primary" onClick={() => setVisible(true)}>Connect wallet</button>
      </section>
    </div>
  );
}

function ConnectedPortfolio({ publicKey }: { publicKey: PublicKey }) {
  const me = publicKey.toBase58();
  const history = usePoll(fetchAllRounds, [], 15_000);
  const data = usePoll(
    async () => {
      if (!history.data) return null;
      const rounds = history.data;
      const markets = rounds.flatMap((r) => r.markets);
      const [holdings, orders] = await Promise.all([
        fetchHoldings(publicKey, markets),
        fetchWalletOrders(publicKey),
      ]);
      const active = new Set(rounds.filter((r) => r.state === "open").map((r) => r.address));
      const ordered = new Set(orders.map((o) => o.market));
      const trades = await Promise.all(
        markets.filter((m) => active.has(m.round) || ordered.has(m.address) ||
          (holdings.yes.get(m.address) ?? 0n) > 0n || (holdings.no.get(m.address) ?? 0n) > 0n).map((m) =>
          fetchTrades(m.address, publicKey)
            .then((t) => t.map((x) => ({ ...x, market: m })))
            .catch((e: unknown) => {
              if (e instanceof TradeIndexingError) return null;
              throw e;
            }),
        ),
      );
      const indexing = trades.some((t) => t === null);
      const mine = trades.flatMap((t) => t ?? []).filter((t) => t.buyer === me || t.seller === me);
      const premium = new Map<string, bigint>();
      const buys = new Map<string, { quantity: bigint; quote: bigint }>();
      for (const t of mine) {
        if (!t.finalized) continue;
        if (t.outcome === Outcome.Yes) {
          const sign = t.buyer === me ? 1n : -1n;
          premium.set(t.market.address, (premium.get(t.market.address) ?? 0n) + sign * t.quoteAmount);
        }
        if (t.buyer === me) {
          const key = `${t.market.address}:${t.outcome}`;
          const prev = buys.get(key) ?? { quantity: 0n, quote: 0n };
          buys.set(key, { quantity: prev.quantity + t.quantity, quote: prev.quote + t.quoteAmount });
        }
      }
      const heldOpen = rounds.flatMap((r) => r.state === "open" ? r.markets : []).filter((m) =>
        m.outcome === "unresolved" && ((holdings.yes.get(m.address) ?? 0n) > 0n || (holdings.no.get(m.address) ?? 0n) > 0n),
      );
      const estimates = await Promise.all(heldOpen.map(async (m) => {
        const book = await fetchBook(m.address).catch(() => null);
        if (!book?.tradingOpen) return null;
        const rows = bookOrders(book);
        return [Outcome.Yes, Outcome.No].map((outcome) => {
          const quantity = (outcome === Outcome.Yes ? holdings.yes : holdings.no).get(m.address) ?? 0n;
          return previewTrade(rows, { outcome, side: OrderSide.Sell, kind: "market", quantity, slippageBps: 10_000 }, me, { shares: quantity, musd: holdings.musd });
        });
      }));
      const sellable = estimates.flatMap((estimate) => estimate ?? []);
      const quoteValue = sellable.reduce((amount, estimate) => amount + estimate.filledQuote, 0n);
      const incompleteValue = estimates.some((estimate) => estimate === null) || sellable.some((estimate) => estimate.restQty > 0n);
      const fills = [...mine].sort((a, b) => b.slot - a.slot).slice(0, 20);
      return { rounds, holdings, orders, fills, indexing, premium, buys, quoteValue, incompleteValue };
    },
    [history.data?.map((r) => r.address + r.state + r.markets.map((m) => m.address + m.outcome).join()).join()],
    6_000,
  );

  if (!data.data) {
    const reason = data.error ?? history.error;
    return reason ? <Unavailable>Portfolio unavailable: {reason}</Unavailable> : <div className="h-96 animate-pulse bg-bg-soft" aria-label="Loading portfolio" />;
  }
  const { rounds, holdings, orders, fills, indexing, premium, buys, quoteValue, incompleteValue } = data.data;
  const reserved = reservedOf(orders);

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
  const coverage = held.filter((x) => x.m.outcome === "unresolved" && x.yes + x.res.yes > 0n);

  return (
    <div className="space-y-8">
      <PageHeader title="Portfolio" />
      <div className="grid grid-cols-2 gap-6 rounded-lg border border-line p-5 sm:grid-cols-4">
        <div>
          <Stat label="Available mUSD" large>{formatMusd(holdings.musd)}</Stat>
          {reserved.musd > 0n && <p className="mt-1 text-xs text-dim">{formatMusd(reserved.musd)} reserved</p>}
        </div>
        <div>
          <Stat label="Estimated sale proceeds" large>{incompleteValue && quoteValue === 0n ? "—" : formatMusd(quoteValue)}</Stat>
          <p className="mt-1 text-xs text-dim">{incompleteValue ? "Partial book depth or unavailable quotes" : "Available shares in open markets"}</p>
        </div>
        <Stat label="Claimable mUSD" large>{formatMusd(claimable)}</Stat>
        <Stat label="Open orders" large>{orders.length}</Stat>
      </div>

      {data.error && <p role="status" className="text-sm text-warn">Portfolio refresh failed. Showing the last successful update.</p>}
      {!history.data && <p className="text-xs text-dim">{history.error ? "Earlier round positions are temporarily unavailable." : "Loading positions from earlier rounds…"}</p>}
      <Panel title="Active protection">
        {coverage.length === 0 ? (
          <div className="text-sm text-dim">No active protection. <Link href="/" className="underline underline-offset-2">Explore property markets</Link></div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[35rem] text-sm">
            <thead className="text-left text-xs text-faint">
              <tr>
                <th className="pb-2 font-medium">Property</th>
                <th className="pb-2 font-medium">Contract</th>
                <th className="pb-2 text-right font-medium">Potential payout</th>
                <th className="pb-2 text-right font-medium">Net YES cost</th>
                <th className="pb-2 pl-4 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {coverage
                .map(({ r, m, yes, res }) => {
                  const c = catalogByProperty(m.propertyId);
                  const shares = yes + res.yes;
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
                      </td>
                      <td className="num py-2.5 text-right">${formatMusd(shares * PAYOUT_PER_SHARE, 0)}</td>
                      <td className="num py-2.5 text-right">{indexing ? "Indexing…" : paid === undefined ? "—" : `$${formatMusd(paid)}`}</td>
                      <td className="py-2.5 pl-4">
                        <StateLabel state={marketState(m.outcome, r)} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table></div>
        )}
        {coverage.length > 0 && <p className="mt-3 text-xs text-dim">Net YES cost comes from indexed finalized buys and sells. Payout follows the contract trigger.</p>}
      </Panel>

      <Panel title="Positions">
        {held.length === 0 ? (
          <div className="text-sm text-dim">No shares or resting orders in the latest rounds.</div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
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
                    </Link>
                    {catalogByProperty(m.propertyId) && <div className="text-xs text-dim">{catalogByProperty(m.propertyId)?.month}</div>}
                  </td>
                  <td className="py-2.5">
                    <StateLabel state={marketState(m.outcome, r)} />
                  </td>
                  <td className="num py-2.5 text-right">{formatShares(yes)}{!indexing && yes > 0n && <IndexedAverage fill={buys.get(`${m.address}:${Outcome.Yes}`)} />}</td>
                  <td className="num py-2.5 text-right">{formatShares(no)}{!indexing && no > 0n && <IndexedAverage fill={buys.get(`${m.address}:${Outcome.No}`)} />}</td>
                  <td className="num py-2.5 text-right text-dim">
                    {res.musd ? `${formatMusd(res.musd)} mUSD` : ""}
                    {res.yes ? ` ${formatShares(res.yes)} YES` : ""}
                    {res.no ? ` ${formatShares(res.no)} NO` : ""}
                    {!res.musd && !res.yes && !res.no ? "—" : ""}
                  </td>
                  <td className="num py-2.5 text-right">{claim > 0n ? <Link className="underline underline-offset-2" href={`/market/${m.address}#position`}>{formatMusd(claim)} mUSD</Link> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {claimable > 0n && <p className="mt-2 text-xs text-faint">Redeem on each market page.</p>}
      </Panel>

      <Panel title="Open orders">
        {orders.length === 0 ? (
          <div className="text-sm text-dim">No open orders.</div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[28rem] text-sm">
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
          </table></div>
        )}
      </Panel>

      <Panel title="Recent fills" right="from finalized and confirming events">
        {indexing && <div className="mb-2 text-xs text-warn">Trade history is still being indexed; some fills may not be listed yet.</div>}
        {fills.length === 0 ? (
          indexing ? null : <div className="text-sm text-dim">No fills yet.</div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[28rem] text-sm">
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
          </table></div>
        )}
      </Panel>
    </div>
  );
}

function IndexedAverage({ fill }: { fill?: { quantity: bigint; quote: bigint } }) {
  if (!fill || fill.quantity === 0n) return null;
  return <div className="text-xs text-dim">Avg. indexed buy {formatMusd(fill.quote / fill.quantity)} mUSD</div>;
}
