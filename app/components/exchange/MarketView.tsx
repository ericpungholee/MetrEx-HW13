"use client";

// One market (spec-v2 §10.3), used by `/` for the featured market and by `/market/[id]`.
// Every number comes from the §7.5 API (on-chain accounts and finalized events) or the wallet's
// own token accounts.
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { Outcome, PAYOUT_PER_SHARE, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
import {
  fetchBook,
  fetchChart,
  fetchEvidenceRaw,
  fetchHealth,
  fetchHoldings,
  fetchMarketInfo,
  fetchTrades,
  fetchWalletOrders,
  sha256HexOf,
  USE_FIXTURES,
  type Headline,
  type MarketInfo,
  type RoundWithMarkets,
} from "@/lib/exchange-client";
import { formatPrice, formatShares, marketState, marketTitle, outcomeName, question } from "@/lib/exchange-format";
import { explorerAddress, formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { PerimeterMap } from "@/components/PerimeterMap";
import { Panel, Stat, TxLink } from "@/components/ui";
import { LiquidityDisclosure, MakerLabel, MakersContext, ReplayDisclosure, StateLabel, TriggerSentence, Unavailable } from "./Labels";
import { OrderBook } from "./OrderBook";
import { PriceChart } from "./PriceChart";
import { TradePanel, type TradePick } from "./TradePanel";
import { WalletPanel } from "./WalletPanel";

function HeadlinePrice({ label, h }: { label: string; h: Headline }) {
  return (
    <div>
      <div className="text-xs font-medium tracking-wide text-faint uppercase">{label}</div>
      <div className="num mt-1 text-3xl font-medium tracking-tight text-ink">{h.source === "none" ? "—" : formatPrice(h.priceBps)}</div>
      <div className="text-xs text-dim">{h.source === "mid" ? "mid" : h.source === "last" ? "last" : "no quotes"}</div>
    </div>
  );
}

function Settlement({ info }: { info: MarketInfo }) {
  const m = info.market;
  const [check, setCheck] = useState<{ hash: string; matches: boolean } | "pending" | "failed" | null>(null);
  useEffect(() => {
    if (USE_FIXTURES || (m.outcome !== "yes" && m.outcome !== "no")) return;
    const controller = new AbortController();
    const { signal } = controller;
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function checkEvidence() {
      const evidence = await fetchEvidenceRaw(m.address, signal).catch(() => null);
      if (signal.aborted) return;
      if (!evidence) {
        setCheck("pending");
        retry = setTimeout(checkEvidence, 3_000);
        return;
      }
      const hash = await sha256HexOf(evidence).catch(() => null);
      if (!signal.aborted) setCheck(hash ? { hash, matches: hash === m.evidenceHash } : "failed");
    }
    void checkEvidence();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [m.address, m.outcome, m.evidenceHash]);

  if (m.outcome === "unresolved") {
    return <div className="text-sm text-dim">{info.round.state === "open" ? "Settles after the round closes. The oracle reads a dataset whose hash was committed on-chain before trading." : "Trading has closed. Waiting for the oracle."}</div>;
  }
  if (m.outcome === "invalid") return <div className="text-sm">Declared invalid. Every YES and NO share redeems for 0.50 mUSD.</div>;
  return (
    <div className="space-y-2 text-sm">
      <div>
        Resolved <span className="font-medium">{m.outcome === "yes" ? "YES" : "NO"}</span>. Each winning share redeems for {formatMusd(PAYOUT_PER_SHARE)} mUSD.
      </div>
      <div className="num text-xs break-all text-dim">On-chain evidence hash {m.evidenceHash}</div>
      {check === "pending" && <div className="text-xs text-warn">Evidence is published after finalized settlement. Checking again shortly.</div>}
      {check === "failed" && <div className="text-xs text-warn">This browser could not verify the evidence hash.</div>}
      {check && typeof check === "object" && (
        <div className={`text-xs ${check.matches ? "text-up" : "text-down"}`}>
          {check.matches ? "Evidence hash recomputed in this browser: matches the chain." : `Evidence hash mismatch (${check.hash}). Do not rely on this file.`}{" "}
          {check.matches && (
            <a className="underline" href={`/api/evidence/${m.address}?raw=1`} target="_blank" rel="noreferrer">
              Evidence
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function MarketView({ market, round, children }: { market: string; round?: RoundWithMarkets | null; children?: ReactNode }) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const [outcome, setOutcome] = useState<OutcomeCode>(Outcome.Yes);
  const [pick, setPick] = useState<TradePick | null>(null);

  const info = usePoll(() => fetchMarketInfo(market), [market], 3_000);
  const book = usePoll(() => fetchBook(market), [market], 2_000);
  const trades = usePoll(() => fetchTrades(market), [market], 5_000);
  const chart = usePoll(() => fetchChart(market), [market], 5_000);
  const health = usePoll(() => fetchHealth(), [], 10_000);
  const m = info.data?.market;
  const wallet = usePoll(
    async () => {
      if (!publicKey || !m) return null;
      const [h, orders] = await Promise.all([fetchHoldings(publicKey, [m]), fetchWalletOrders(publicKey)]);
      return { musd: h.musd, yes: h.yes.get(m.address) ?? 0n, no: h.no.get(m.address) ?? 0n, orders };
    },
    [me, m?.address],
    4_000,
  );
  const refresh = () => {
    book.refresh();
    info.refresh();
    wallet.refresh();
    trades.refresh();
  };

  const makers = useMemo(() => health.data?.marketMakers ?? new Map<string, string>(), [health.data]);

  if (info.data === null) return <div className="py-16 text-center text-sm text-dim">Market not found on this cluster.</div>;
  if (!info.data || !m) return info.error ? <Unavailable>Exchange data unavailable: {info.error}</Unavailable> : <div className="h-96 animate-pulse bg-bg-soft" />;

  const r = info.data.round;
  const state = marketState(m.outcome, r);
  const closed = !info.data.tradingOpen || m.outcome !== "unresolved";
  const siblings = round?.markets.filter((x) => x.address !== m.address) ?? [];

  return (
    <MakersContext.Provider value={makers}>
      <div className="space-y-10">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-dim">
            <Link href="/rounds" className="hover:text-ink">
              Round #{r.roundId.toString()} · {r.label}
            </Link>
            <StateLabel state={state} />
            <a className="hover:text-ink" href={explorerAddress(m.address)} target="_blank" rel="noreferrer">
              Market on Explorer
            </a>
          </div>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{question(m)}</h1>
          <TriggerSentence />
          <ReplayDisclosure />
        </div>

        <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-5">
              <HeadlinePrice label="YES" h={info.data.headline.yes} />
              <HeadlinePrice label="NO" h={info.data.headline.no} />
              <Stat label="Volume (finalized)">
                {info.data.volume === null ? <span className="text-dim">indexing…</span> : <>{formatMusd(info.data.volume)} <span className="text-faint">mUSD</span></>}
              </Stat>
            </div>
            {info.data.confirmingFills > 0 && <div className="text-xs text-warn">{info.data.confirmingFills} fill(s) confirming; not yet in volume or the chart.</div>}
            <PriceChart chart={chart.data} outcome={outcome} />
          </div>
          <PerimeterMap
            points={[{ key: m.address, lat: m.latE6 / 1e6, lon: m.lonE6 / 1e6, label: marketTitle(m), radiusM: m.triggerDistanceM, selected: true }]}
            settledMarket={m.outcome === "yes" || m.outcome === "no" ? m.address : undefined}
            height={340}
          />
        </div>

        <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
          <Panel title="Order book" right={health.data && health.data.matching === "paused" ? <span className="text-warn">Matching paused (keeper offline)</span> : undefined}>
            {book.error && !book.data ? (
              <Unavailable>Book unavailable: {book.error}</Unavailable>
            ) : (
              <OrderBook
                book={outcome === Outcome.Yes ? book.data?.yes : book.data?.no}
                outcome={outcome}
                onOutcome={setOutcome}
                onPick={(priceBps: number, side: OrderSideCode) => setPick({ priceBps, side, at: Date.now() })}
                me={me}
                closed={closed}
              />
            )}
            <div className="mt-4">
              <LiquidityDisclosure />
            </div>
          </Panel>
          <Panel title="Trade">
            <TradePanel market={m} book={book.data} outcome={outcome} onOutcome={setOutcome} have={wallet.data ?? null} tradingOpen={!closed} pick={pick} onDone={refresh} />
          </Panel>
        </div>

        <Panel title="Your position">
          <WalletPanel market={m} have={wallet.data ?? null} orders={wallet.data?.orders} trades={trades.data} onDone={refresh} />
        </Panel>

        <div className="grid gap-10 lg:grid-cols-2">
          <Panel title="Recent trades" right="finalized fills; newer ones marked confirming">
            {!trades.data ? (
              trades.error ? <Unavailable>{trades.error}</Unavailable> : <div className="h-24 animate-pulse bg-bg-soft" />
            ) : trades.data.length === 0 ? (
              <div className="text-sm text-dim">No trades yet.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {trades.data.slice(0, 12).map((t) => (
                    <tr key={`${t.signature}-${t.buyer}-${t.seller}-${t.quantity}`} className="border-t border-line">
                      <td className="py-2">
                        {formatShares(t.quantity)} {outcomeName(t.outcome)} @ <span className="num">{formatPrice(t.priceBps)}</span>
                      </td>
                      <td className="py-2 text-xs">
                        <MakerLabel address={t.buyer} me={me} short /> ← <MakerLabel address={t.seller} me={me} short />
                      </td>
                      <td className="py-2 text-right">
                        {!t.finalized && <span className="mr-2 text-xs text-warn">confirming</span>}
                        <TxLink signature={t.signature} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="Settlement">
            <Settlement key={`${m.address}:${m.evidenceHash}`} info={info.data} />
          </Panel>
        </div>

        {siblings.length > 0 && (
          <Panel title="Other markets in this round">
            <div className="divide-y divide-line">
              {siblings.map((s) => (
                <Link key={s.address} href={`/market/${s.address}`} className="flex items-center justify-between py-3 text-sm hover:bg-bg-soft">
                  <span className="font-medium text-ink">{marketTitle(s)}</span>
                  <StateLabel state={marketState(s.outcome, r)} />
                </Link>
              ))}
            </div>
          </Panel>
        )}
        {children}
        <p className="text-xs text-faint">
          Market {m.address.slice(0, 8)}… · vault <a className="hover:underline" href={explorerAddress(new PublicKey(m.vault))} target="_blank" rel="noreferrer">{m.vault.slice(0, 8)}…</a> · {formatShares(m.pairsOutstanding)} pairs outstanding
        </p>
      </div>
    </MakersContext.Provider>
  );
}
