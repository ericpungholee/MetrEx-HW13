"use client";

// One market (spec-v2 §10.3), used by `/` for the featured market and by `/market/[id]`.
// Layout follows a Kalshi/Polymarket-style trading desk: question + YES/NO prices, chart and
// book on the left, compact trade ticket on the right. Every number comes from the §7.5 API.
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { catalogByProperty, HAZARD_LABEL, Outcome, PAYOUT_PER_SHARE, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
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
import { formatPrice, formatShares, marketState, marketTitle, outcomeName, payoutRule, question } from "@/lib/exchange-format";
import { explorerAddress, formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { Panel, TxLink } from "@/components/ui";
import { LiquidityDisclosure, MakerLabel, MakersContext, ReplayDisclosure, StateLabel, TriggerSentence, Unavailable } from "./Labels";
import { OrderBook } from "./OrderBook";
import { MarketPhoto, MarketPhotoCredit } from "./MarketPhoto";
import { MarketRiskMap } from "./MarketRiskMap";
import { PriceChart } from "./PriceChart";
import { TradePanel, type TradePick } from "./TradePanel";
import { WalletPanel } from "./WalletPanel";

function OutcomePrice({
  label,
  h,
  selected,
  onSelect,
}: {
  label: "YES" | "NO";
  h: Headline;
  selected: boolean;
  onSelect: () => void;
}) {
  const yes = label === "YES";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-w-0 flex-1 items-center justify-between gap-3 border px-4 py-3 text-left transition-colors ${
        selected ? (yes ? "border-up bg-up-soft" : "border-down bg-down-soft") : "border-line hover:bg-bg-soft"
      }`}
    >
      <span className={`text-sm font-semibold ${yes ? "text-up" : "text-down"}`}>{label}</span>
      <span className="text-right">
        <span className="num block text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          {h.source === "none" ? "—" : formatPrice(h.priceBps)}
        </span>
        <span className="text-[11px] text-faint">{h.source === "mid" ? "mid" : h.source === "last" ? "last" : "no quotes"}</span>
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

export function MarketView({ market, round, children }: { market: string; round?: RoundWithMarkets | null; children?: ReactNode }) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const [outcome, setOutcome] = useState<OutcomeCode>(Outcome.Yes);
  const [pick, setPick] = useState<TradePick | null>(null);
  const [tab, setTab] = useState<"book" | "trades">("book");

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
  const c = catalogByProperty(m.propertyId);

  return (
    <MakersContext.Provider value={makers}>
      <div className="space-y-6 animate-in">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
            <Link href="/rounds" className="hover:text-ink">
              Round #{r.roundId.toString()}
            </Link>
            <span className="text-faint">·</span>
            <StateLabel state={state} />
            <span className="text-faint">·</span>
            <span className="num">
              Vol {info.data.volume === null ? "…" : `${formatMusd(info.data.volume)} mUSD`}
            </span>
            {info.data.confirmingFills > 0 && (
              <>
                <span className="text-faint">·</span>
                <span className="text-warn">{info.data.confirmingFills} confirming</span>
              </>
            )}
            <a className="ml-auto hover:text-ink" href="#risk-map">Risk map</a>
            <a className="hover:text-ink" href={explorerAddress(m.address)} target="_blank" rel="noreferrer">
              Explorer
            </a>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {c && (
              <figure className="order-1 w-full shrink-0 sm:order-none sm:w-40">
                <MarketPhoto photo={c.photo} sizes="(min-width: 40rem) 160px, 100vw" className="h-32 rounded-md sm:h-24" />
                <figcaption className="mt-1 leading-4"><MarketPhotoCredit photo={c.photo} /></figcaption>
              </figure>
            )}
            <div className="min-w-0 space-y-2">
              {c && (
                <div className="text-xs text-dim">
                  {c.place} · {HAZARD_LABEL[c.hazard]} · {c.month} contract · Trigger: {c.trigger}
                </div>
              )}
              <h1 className="max-w-4xl text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{question(m)}</h1>
              <p className="max-w-3xl text-[11px] leading-snug text-faint">
                <TriggerSentence text={payoutRule(m)} /> <ReplayDisclosure className="inline" replayOf={c?.replayOf} />
                {c && <> Settlement data: {c.source}. Its SHA-256 was committed on-chain when this round opened.</>}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <OutcomePrice label="YES" h={info.data.headline.yes} selected={outcome === Outcome.Yes} onSelect={() => setOutcome(Outcome.Yes)} />
          <OutcomePrice label="NO" h={info.data.headline.no} selected={outcome === Outcome.No} onSelect={() => setOutcome(Outcome.No)} />
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            <PriceChart chart={chart.data} outcome={outcome} />

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
                    onPick={(priceBps: number, side: OrderSideCode) => setPick({ priceBps, side, at: Date.now() })}
                    me={me}
                    closed={closed}
                    compact
                  />
                ))}

              {tab === "trades" &&
                (!trades.data ? (
                  trades.error ? <Unavailable>{trades.error}</Unavailable> : <div className="h-24 animate-pulse bg-bg-soft" />
                ) : trades.data.length === 0 ? (
                  <div className="py-8 text-center text-sm text-dim">No trades yet.</div>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {trades.data.slice(0, 16).map((t) => (
                        <tr key={`${t.signature}-${t.buyer}-${t.seller}-${t.quantity}`} className="border-t border-line">
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

          <aside className="lg:sticky lg:top-20">
            <div className="border border-line bg-bg p-4 sm:p-5">
              <div className="mb-3 text-xs font-medium tracking-wide text-faint uppercase">Trade</div>
              <TradePanel market={m} book={book.data} outcome={outcome} onOutcome={setOutcome} have={wallet.data ?? null} tradingOpen={!closed} pick={pick} onDone={refresh} />
            </div>
          </aside>
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

        <Panel title="Position">
          <WalletPanel market={m} have={wallet.data ?? null} orders={wallet.data?.orders} trades={trades.data} onDone={refresh} />
        </Panel>

        <div className="grid gap-8 lg:grid-cols-2">
          <Panel title="Settlement">
            <Settlement key={`${m.address}:${m.evidenceHash}`} info={info.data} />
          </Panel>
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

        {children}
        <div className="space-y-1 border-t border-line pt-4 text-xs text-faint">
          <LiquidityDisclosure />
          <p>
            {m.address.slice(0, 8)}… · vault{" "}
            <a className="hover:underline" href={explorerAddress(new PublicKey(m.vault))} target="_blank" rel="noreferrer">
              {m.vault.slice(0, 8)}…
            </a>{" "}
            · {formatShares(m.pairsOutstanding)} pairs
          </p>
        </div>
      </div>
    </MakersContext.Provider>
  );
}
