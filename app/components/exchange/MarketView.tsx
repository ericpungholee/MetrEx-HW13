"use client";

// One market (spec-v2 §10.3), used by `/` for the featured market and by `/market/[id]`.
// Layout follows a Kalshi/Polymarket-style trading desk: question + YES/NO prices, chart and
// book on the left, compact trade ticket on the right. Every number comes from the §7.5 API.
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { catalogByProperty, HAZARD_LABEL, Outcome, PAYOUT_PER_SHARE, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
import {
  fetchBook,
  fetchChart,
  fetchEvidenceRaw,
  fetchHealth,
  fetchHoldings,
  fetchMarketInfo,
  fetchRound,
  fetchTrades,
  fetchWalletOrders,
  sha256HexOf,
  USE_FIXTURES,
  type Headline,
  type MarketInfo,
} from "@/lib/exchange-client";
import { formatPrice, formatRemaining, formatShares, marketState, marketTitle, outcomeName, payoutRule, question } from "@/lib/exchange-format";
import { explorerAddress, formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { Panel, TxLink } from "@/components/ui";
import { MakerLabel, MakersContext, StateLabel, Unavailable } from "./Labels";
import { OrderBook } from "./OrderBook";
import { MarketPhoto } from "./MarketPhoto";
import { MarketRiskMap } from "./MarketRiskMap";
import { PriceChart } from "./PriceChart";
import { MarketControls } from "./MarketControls";
import { TradePanel, type TradePick } from "./TradePanel";
import { WalletPanel } from "./WalletPanel";

function OutcomePrice({
  label,
  h,
  ask,
  selected,
  onSelect,
}: {
  label: "YES" | "NO";
  h: Headline;
  ask: number | null | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const yes = label === "YES";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 rounded-md border px-3 py-2 text-left transition-colors ${
        selected ? (yes ? "border-up/40 bg-up-soft" : "border-down/40 bg-down-soft") : "border-line hover:bg-bg-soft"
      }`}
    >
      <span className={`text-sm font-semibold ${yes ? "text-up" : "text-down"}`}>{label}</span>
      <span className="text-right">
        <span className="num block text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {formatPrice(ask ?? h.priceBps)}
        </span>
        <span className="text-xs text-dim">{ask != null ? "Best ask" : h.source === "mid" ? "Midpoint" : h.source === "last" ? "Last trade" : "No price"}</span>
      </span>
    </button>
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
    return (
      <div className="text-sm text-dim">
        {info.round.state === "open" ? "Settles after close from a pre-committed dataset hash." : "Trading closed. Waiting for the oracle."}
      </div>
    );
  }
  if (m.outcome === "invalid") return <div className="text-sm">Invalid — every share redeems for 0.50 mUSD.</div>;
  return (
    <div className="space-y-1.5 text-sm">
      <div>
        Resolved <span className="font-medium">{m.outcome === "yes" ? "YES" : "NO"}</span> · {formatMusd(PAYOUT_PER_SHARE)} mUSD per winning share
      </div>
      <div className="num text-[11px] break-all text-faint">{m.evidenceHash}</div>
      {check === "pending" && <div className="text-xs text-warn">Checking evidence…</div>}
      {check === "failed" && <div className="text-xs text-warn">Could not verify evidence hash.</div>}
      {check && typeof check === "object" && (
        <div className={`text-xs ${check.matches ? "text-up" : "text-down"}`}>
          {check.matches ? "Evidence matches chain." : `Hash mismatch (${check.hash}).`}{" "}
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

export function MarketView({ market, initialOutcome }: {
  market: string;
  initialOutcome?: OutcomeCode;
}) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const [outcome, setOutcome] = useState<OutcomeCode>(initialOutcome ?? Outcome.Yes);
  const [pick, setPick] = useState<TradePick | null>(null);
  const [tab, setTab] = useState<"book" | "trades">("book");

  const info = usePoll(() => fetchMarketInfo(market), [market], 3_000);
  const book = usePoll(() => fetchBook(market), [market], 2_000);
  const trades = usePoll(() => fetchTrades(market), [market], 2_000);
  const chart = usePoll(() => fetchChart(market), [market], 2_000);
  const health = usePoll(() => fetchHealth(), [], 10_000);
  const m = info.data?.market;
  const siblingRound = info.data && info.data.round.marketCount > 1 ? info.data.round.address : undefined;
  const related = usePoll(() => siblingRound ? fetchRound(siblingRound) : Promise.resolve(null), [siblingRound], 15_000);
  const wallet = usePoll(
    async () => {
      if (!publicKey || !m) return null;
      const [h, orders] = await Promise.all([
        fetchHoldings(publicKey, [m]),
        fetchWalletOrders(publicKey).catch(() => fetchWalletOrders(publicKey, m.address)),
      ]);
      return { owner: publicKey.toBase58(), musd: h.musd, yes: h.yes.get(m.address) ?? 0n, no: h.no.get(m.address) ?? 0n, orders };
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
  const afterSettle = () => {
    refresh();
    chart.refresh();
  };
  const selectOutcome = setOutcome;

  const makers = useMemo(() => health.data?.marketMakers ?? new Map<string, string>(), [health.data]);
  // Remaining time counts down to the on-chain trading_ends_at (docs/spec-simulation.md §6).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  if (info.data === null) return <div className="py-16 text-center text-sm text-dim">Market not found on this cluster.</div>;
  if (!info.data || !m) return info.error ? <Unavailable>Exchange data unavailable: {info.error}</Unavailable> : <div className="h-96 animate-pulse bg-bg-soft" />;

  const r = info.data.round;
  const state = marketState(m.outcome, r);
  const closed = !info.data.tradingOpen || m.outcome !== "unresolved";
  const siblings = related.data?.address === m.round ? related.data.markets.filter((x) => x.address !== m.address) : [];
  const c = catalogByProperty(m.propertyId);
  const walletData = wallet.data?.owner === me ? wallet.data : null;
  const activeBook = !closed && !book.error && book.data?.tradingOpen ? book.data : undefined;
  const deadlines = r.tradingEndsAt > 0n ? new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(Number(r.tradingEndsAt) * 1000) : null;

  return (
    <MakersContext.Provider value={makers}>
      <div className="space-y-6 animate-in">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
            <Link href="/" className="hover:text-ink">Markets</Link>
            <span className="text-faint">·</span>
            <StateLabel state={state} />
            {info.data.volume !== null && <span className="num">· {info.data.indexing ? "Indexed vol" : "Vol"} {formatMusd(info.data.volume)} mUSD</span>}
            {r.state === "open" && m.outcome === "unresolved" && formatRemaining(r.tradingEndsAt, nowMs) && <span className="num">· {formatRemaining(r.tradingEndsAt, nowMs)} left</span>}
            {info.data.confirmingFills > 0 && (
              <>
                <span className="text-faint">·</span>
                <span className="text-warn">{info.data.confirmingFills} confirming</span>
              </>
            )}
            <a className="ml-auto hover:text-ink lg:hidden" href="#trade">Trade</a>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {c && (
              <div className="order-1 shrink-0 sm:order-none sm:w-32">
                <MarketPhoto photo={c.photo} sizes="(min-width: 40rem) 128px, 80px" className="h-12 w-20 rounded-md sm:h-20 sm:w-full" />
              </div>
            )}
            <div className="min-w-0 space-y-2">
              {c && (
                <div className="text-xs text-dim">
                  {HAZARD_LABEL[c.hazard]} · {c.place} · {c.month}
                </div>
              )}
              <h1 className="max-w-4xl text-2xl font-semibold tracking-tight text-ink sm:text-4xl">{question(m)}</h1>
            </div>
          </div>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid min-w-0 grid-cols-2 gap-2 lg:col-start-1 lg:row-start-1">
            <OutcomePrice label="YES" h={info.data.headline.yes} ask={activeBook?.yes.bestAskBps} selected={outcome === Outcome.Yes} onSelect={() => selectOutcome(Outcome.Yes)} />
            <OutcomePrice label="NO" h={info.data.headline.no} ask={activeBook?.no.bestAskBps} selected={outcome === Outcome.No} onSelect={() => selectOutcome(Outcome.No)} />
          </div>
          <aside id="trade" aria-label="Trade ticket" className="scroll-mt-20 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <div className="rounded-lg border border-line bg-bg p-4 sm:p-5">
              <TradePanel market={m} book={activeBook} outcome={outcome} onOutcome={selectOutcome} have={walletData} tradingOpen={!closed} pick={pick} onDone={refresh} />
            </div>
            <div className="mt-3">
              <MarketControls info={info.data} onSettled={afterSettle} />
            </div>
          </aside>
          <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-2">
            <PriceChart key={outcome} chart={chart.error ? undefined : chart.data} unavailable={!!chart.error} outcome={outcome} />

            <div>
              <div className="mb-3 flex items-center gap-1 border-b border-line text-sm">
                {(
                  [
                    ["book", "Order book"],
                    ["trades", "Trades"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={tab === id}
                    onClick={() => setTab(id)}
                    className={`-mb-px border-b-2 px-3 py-2 transition-colors ${
                      tab === id ? "border-ink font-medium text-ink" : "border-transparent text-dim hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {tab === "book" && health.data?.matching === "paused" && (
                  <span className="ml-auto text-xs text-warn">Matching paused</span>
                )}
              </div>

              {tab === "book" &&
                (book.error && !book.data ? (
                  <Unavailable>Book unavailable: {book.error}</Unavailable>
                ) : (
                  <OrderBook
                    book={outcome === Outcome.Yes ? book.data?.yes : book.data?.no}
                    outcome={outcome}
                    onOutcome={setOutcome}
                    onPick={(priceBps: number, side: OrderSideCode) => {
                      setPick({ priceBps, side, at: Date.now() });
                    }}
                    me={me}
                    closed={closed}
                    compact
                  />
                ))}

              {tab === "trades" &&
                (!trades.data ? (
                  trades.error ? <Unavailable>{trades.error}</Unavailable> : <div className="h-24 animate-pulse bg-bg-soft" />
                ) : trades.data.trades.length === 0 ? (
                  <div className="py-8 text-center text-sm text-dim">{trades.data.indexing ? "Waiting for indexed fills…" : "No trades yet."}</div>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {trades.data.trades.slice(0, 16).map((t) => (
                        <tr key={t.eventId} className="border-t border-line">
                          <td className="py-2">
                            {formatShares(t.quantity)} {outcomeName(t.outcome)} @ <span className="num">{formatPrice(t.priceBps)}</span>
                          </td>
                          <td className="py-2 text-xs text-dim">
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
                ))}

            </div>
          </div>

        </div>

        <MarketRiskMap
          key={`${m.address}:${m.evidenceHash}`}
          address={m.address}
          evidenceHash={m.evidenceHash}
          latE6={m.latE6}
          lonE6={m.lonE6}
          triggerDistanceM={m.triggerDistanceM}
          outcome={m.outcome}
          label={marketTitle(m)}
          pointTrigger={c?.trigger}
          zoom={c?.hazard === "hurricane" ? 10 : c?.hazard === "earthquake" ? 13 : 14}
        />

        <div id="position" className="scroll-mt-20">
          <Panel title="Position">
            <WalletPanel market={m} have={walletData} orders={walletData?.orders} trades={trades.data?.trades} onDone={refresh} />
          </Panel>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          <section aria-labelledby="rules-title" className="space-y-2 border-t border-line pt-4">
            <h2 id="rules-title" className="text-lg font-semibold tracking-tight">Market rules</h2>
            <p className="text-sm text-ink-secondary">{payoutRule(m)}</p>
            {c && <p className="text-sm text-dim">Historical replay · {c.month} ({c.coverageStart.slice(0, 10)} to {c.coverageEndExclusive.slice(0, 10)}, end exclusive)</p>}
            <p className="text-sm text-dim">Devnet trading opened {new Date(Number(r.createdAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.</p>
            {deadlines && (
              <p className="text-sm text-dim">
                Devnet trading deadline {deadlines} UTC
                {r.state === "open" && m.outcome === "unresolved" && (formatRemaining(r.tradingEndsAt, nowMs) ? ` · ${formatRemaining(r.tradingEndsAt, nowMs)} left` : " · deadline passed, awaiting oracle settlement")}
              </p>
            )}
            {c && <p className="text-sm text-dim">Settlement source · {c.source}</p>}
          </section>
          <section id="settlement" aria-labelledby="settlement-title" className="scroll-mt-20 space-y-2 border-t border-line pt-4">
            <h2 id="settlement-title" className="text-lg font-semibold tracking-tight">Settlement</h2>
            {info.data.settlementDeadline && <p className="text-sm text-dim">Oracle settlement deadline {new Date(Number(info.data.settlementDeadline) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.</p>}
            <Settlement key={`${m.address}:${m.evidenceHash}`} info={info.data} />
            <p className="text-sm"><Link href={`/market/${m.address}/ledger`} className="underline underline-offset-2">Trade and settlement ledger</Link> <span className="text-dim">· every fill, position and payout from on-chain events</span></p>
            <details className="text-xs text-dim">
              <summary className="cursor-pointer">On-chain details</summary>
              <p className="mt-2 break-all">Round #{r.roundId.toString()} · Dataset SHA-256 {r.datasetSha256}</p>
              <a className="mt-1 inline-block underline" href={explorerAddress(m.address)} target="_blank" rel="noreferrer">Market on Solana Explorer</a>
            </details>
          </section>
          {siblings.length > 0 && (
            <Panel title="Same round">
              <div className="divide-y divide-line">
                {siblings.map((s) => (
                  <Link key={s.address} href={`/market/${s.address}`} className="flex items-center justify-between py-2.5 text-sm hover:bg-bg-soft">
                    <span className="font-medium text-ink">{marketTitle(s)}</span>
                    <StateLabel state={marketState(s.outcome, r)} />
                  </Link>
                ))}
              </div>
            </Panel>
          )}
        </div>

      </div>
    </MakersContext.Provider>
  );
}
