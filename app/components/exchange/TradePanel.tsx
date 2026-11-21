"use client";

// §10.3 trade panel. The preview is computed from the live book with the same planner that builds
// the transaction; before the wallet opens the transaction is simulated and a program error is
// shown in plain words. If the book moved, the whole transaction fails with nothing moved.
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { OrderSide, Outcome, PAYOUT_PER_SHARE, INVALID_PAYOUT_PER_SHARE, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
import {
  bookOrders,
  buildTrade,
  previewTrade,
  sendTrade,
  simulate,
  USE_FIXTURES,
  type BookInfo,
  type MarketSummary,
  type TradeIntent,
} from "@/lib/exchange-client";
import { formatCents, formatPrice, formatShares, outcomeName, parsePriceToBps } from "@/lib/exchange-format";
import { formatMusd } from "@/lib/format";
import { useWalletSigner } from "@/lib/useWalletSigner";
import { useTx } from "@/components/TxProvider";
import { InvalidDisclosure } from "./Labels";

function Toggle<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="grid border border-line" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" onClick={() => onChange(v)} className={`px-3 py-2 text-sm ${value === v ? "bg-ink text-bg" : "text-dim hover:text-ink"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export interface TradePick {
  priceBps: number;
  side: OrderSideCode;
  at: number;
}

export function TradePanel({
  market,
  book,
  outcome,
  onOutcome,
  have,
  tradingOpen,
  pick,
  onDone,
}: {
  market: MarketSummary;
  book: BookInfo | undefined;
  outcome: OutcomeCode;
  onOutcome: (o: OutcomeCode) => void;
  have: { musd: bigint; yes: bigint; no: bigint } | null;
  tradingOpen: boolean;
  pick: TradePick | null;
  onDone: () => void;
}) {
  const { publicKey } = useWallet();
  const signer = useWalletSigner();
  const { run } = useTx();
  // "coverage": buy YES at market, sized in dollars of payout (docs/spec-multiperil.md §7.4).
  const [mode, setMode] = useState<"coverage" | "shares">("coverage");
  const [coverText, setCoverText] = useState("100000");
  const [sideRaw, setSide] = useState<OrderSideCode>(OrderSide.Buy);
  const [kindRaw, setKind] = useState<"market" | "limit">("market");
  const [qtyText, setQtyText] = useState("100");
  const [priceText, setPriceText] = useState("");
  const [slipText, setSlipText] = useState("100");
  // Default slippage follows the mode: tighter for coverage buys, looser for share trading.
  useEffect(() => setSlipText(mode === "coverage" ? "100" : "200"), [mode]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clicking a book level fills a limit order that would trade against it.
  useEffect(() => {
    if (!pick) return;
    setMode("shares");
    setKind("limit");
    setSide(pick.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy);
    setPriceText(formatPrice(pick.priceBps));
  }, [pick]);

  const coverage = mode === "coverage";
  const side = coverage ? OrderSide.Buy : sideRaw;
  const kind = coverage ? "market" : kindRaw;
  const coverDigits = coverText.replace(/[$,\s]/g, "");
  const qty = coverage
    ? /^\d{1,7}$/.test(coverDigits)
      ? BigInt(coverDigits)
      : 0n
    : /^\d{1,7}$/.test(qtyText.trim())
      ? BigInt(qtyText.trim())
      : 0n;
  const priceBps = parsePriceToBps(priceText);
  const slippage = /^\d{1,4}$/.test(slipText.trim()) ? Number(slipText.trim()) : coverage ? 100 : 200;
  const me = publicKey?.toBase58() ?? "";
  const rows = useMemo(() => (book ? bookOrders(book) : []), [book]);
  const intent: TradeIntent = { outcome, side, kind, quantity: qty, priceBps: priceBps ?? undefined, slippageBps: slippage };
  const shares = have ? (outcome === Outcome.Yes ? have.yes : have.no) : 0n;
  // Without a wallet there is no balance to check: preview the fills only.
  const unlimited = 2n ** 63n;
  const balances = publicKey ? { musd: have?.musd ?? 0n, shares } : { musd: unlimited, shares: unlimited };
  const preview = book ? previewTrade(rows, intent, me, balances) : null;
  const problems = [
    ...(kind === "limit" && priceBps === null ? ["Enter a limit price in cents, for example 0.86."] : []),
    ...(preview?.problems ?? []),
  ];

  useEffect(() => setError(null), [side, kind, qtyText, priceText, slipText, outcome, mode, coverText]);
  useEffect(() => {
    if (coverage && outcome !== Outcome.Yes) onOutcome(Outcome.Yes);
  }, [coverage, outcome, onOutcome]);

  async function submit() {
    if (!publicKey || !signer || !preview || !book) return;
    setBusy(true);
    setError(null);
    try {
      const built = await buildTrade(publicKey, market, rows, preview);
      try {
        await simulate(built.ixs, publicKey); // before the wallet opens (§10.3)
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      const label = coverage
        ? `Buy $${formatShares(preview.filledQty)} of coverage (${formatShares(preview.filledQty)} YES)`
        : `${side === OrderSide.Buy ? "Buy" : "Sell"} ${formatShares(qty)} ${outcomeName(outcome)}${kind === "limit" ? ` @ ${formatPrice(preview.limitPriceBps)}` : " at market"}`;
      const res = await run(label, (opts) => sendTrade(signer, built.ixs, opts));
      if (res) onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const payout = qty * PAYOUT_PER_SHARE;
  const invalidPayout = qty * INVALID_PAYOUT_PER_SHARE;
  const o = outcomeName(outcome);

  return (
    <div className="space-y-3">
      <Toggle value={mode} options={[["coverage", "Buy coverage ($)"], ["shares", "Trade shares"]]} onChange={setMode} />
      {coverage ? (
        <>
          <label className="block">
            <span className="text-[11px] font-medium tracking-wide text-faint uppercase">Payout if triggered ($ = YES shares)</span>
            <input className="input num mt-1 w-full" inputMode="numeric" value={coverText} onChange={(e) => setCoverText(e.target.value)} />
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {["25000", "50000", "100000", "250000"].map((v) => (
              <button key={v} type="button" onClick={() => setCoverText(v)} className={`border px-2 py-1 text-xs ${coverDigits === v ? "border-ink text-ink" : "border-line text-dim hover:text-ink"}`}>
                ${Number(v) / 1000}k
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <Toggle value={side} options={[[OrderSide.Buy, "Buy"], [OrderSide.Sell, "Sell"]]} onChange={setSide} />
          <Toggle value={outcome} options={[[Outcome.Yes, "YES"], [Outcome.No, "NO"]]} onChange={onOutcome} />
          <Toggle value={kind} options={[["market", "Market"], ["limit", "Limit"]]} onChange={setKind} />
          <label className="block">
            <span className="text-[11px] font-medium tracking-wide text-faint uppercase">Shares</span>
            <input className="input num mt-1 w-full" inputMode="numeric" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
          </label>
        </>
      )}
      {kind === "limit" ? (
        <label className="block">
          <span className="text-[11px] font-medium tracking-wide text-faint uppercase">Limit (¢ per share)</span>
          <input className="input num mt-1 w-full" placeholder="0.86" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </label>
      ) : (
        <label className="block">
          <span className="text-[11px] font-medium tracking-wide text-faint uppercase">Slippage (bps; 1 bps = 0.01¢)</span>
          <input className="input num mt-1 w-full" inputMode="numeric" value={slipText} onChange={(e) => setSlipText(e.target.value)} />
        </label>
      )}

      {coverage && tradingOpen && preview && qty > 0n && book?.yes.bestAskBps != null && <CoverageQuote preview={preview} requested={qty} bestAskBps={book?.yes.bestAskBps ?? null} />}

      {!coverage && preview && qty > 0n && (
        <div className="space-y-1 border border-line bg-bg-soft px-3 py-2.5 text-xs leading-snug">
          {preview.filledQty > 0n ? (
            <div>
              <span className="num font-medium">{formatShares(preview.filledQty)}</span> @ avg{" "}
              <span className="num font-medium">{formatMusd(preview.avgPerShare ?? 0n, 4)}</span>
              {kind === "market" && <span className="text-dim"> · worst {formatPrice(preview.limitPriceBps)}</span>}
            </div>
          ) : (
            <div className="text-dim">No fill{kind === "limit" ? "" : " within worst price"}</div>
          )}
          {kind === "limit" && preview.restQty > 0n && (
            <div>
              <span className="num font-medium">{formatShares(preview.restQty)}</span> rest @ {formatPrice(preview.limitPriceBps)}
              <span className="text-dim">
                {" · escrow "}
                {side === OrderSide.Buy ? <span className="num">{formatMusd(preview.escrow.musd)} mUSD</span> : <span className="num">{formatShares(preview.escrow.shares)} {o}</span>}
              </span>
            </div>
          )}
          {kind === "market" && preview.restQty > 0n && preview.filledQty > 0n && (
            <div className="text-dim">{formatShares(preview.restQty)} unfilled (not sent)</div>
          )}
          {kind === "limit" && preview.restQty === 0n && (
            <div className="text-dim">
              Escrow {side === OrderSide.Buy ? <span className="num">{formatMusd(preview.escrow.musd)} mUSD</span> : <span className="num">{formatShares(preview.escrow.shares)} {o}</span>}
            </div>
          )}
          {side === OrderSide.Buy ? (
            <div className="num text-dim">
              Cost {formatMusd(kind === "limit" ? preview.escrow.musd : preview.filledQuote)} · max {formatMusd(kind === "limit" ? payout : preview.filledQty * PAYOUT_PER_SHARE)}
              {" · "}
              {formatMusd(kind === "limit" ? invalidPayout : preview.filledQty * INVALID_PAYOUT_PER_SHARE)} if invalid
            </div>
          ) : (
            <div className="text-dim">
              Get <span className="num">{formatMusd(preview.filledQuote)} mUSD</span>
              {kind === "limit" && preview.restQty > 0n ? " + rest" : ""} · gives up {formatShares(kind === "limit" ? qty : preview.filledQty)} if {o} wins
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && qty > 0n && <div className="text-xs text-warn">{problems[0]}</div>}
      {error && <div className="border border-down/30 bg-down-soft px-3 py-2 text-xs text-down">{error}</div>}

      <button
        type="button"
        className={`btn w-full ${side === OrderSide.Buy ? "btn-up" : "btn-down"}`}
        disabled={USE_FIXTURES || !publicKey || !tradingOpen || busy || !preview || problems.length > 0 || qty === 0n}
        onClick={submit}
      >
        {!publicKey
          ? "Connect wallet"
          : !tradingOpen
            ? "Closed"
            : busy
              ? "Checking…"
              : coverage
                ? `Buy $${formatShares(preview?.filledQty ?? 0n)} of coverage`
                : `${side === OrderSide.Buy ? "Buy" : "Sell"} ${o}`}
      </button>
      <InvalidDisclosure />
    </div>
  );
}

/**
 * Coverage quote (docs/spec-multiperil.md §7.4): the actual cost of filling the coverage from the live
 * book, including slippage, next to what the best price alone would suggest. Nothing here is a fixed premium.
 */
function CoverageQuote({ preview, requested, bestAskBps }: { preview: NonNullable<ReturnType<typeof previewTrade>>; requested: bigint; bestAskBps: number | null }) {
  const filled = preview.filledQty;
  const premium = preview.filledQuote;
  const atBest = bestAskBps === null ? null : quoteAtBps(filled, bestAskBps);
  const slip = atBest === null ? 0n : premium - atBest;
  // One base unit is 1e-6 mUSD = 1e-4 ¢, so premium / filled is the average price in 1e-4 ¢ (truncated).
  const avgCentsE4 = filled > 0n ? premium / filled : null;
  const avgText = avgCentsE4 === null ? "—" : `${(Number(avgCentsE4) / 10_000).toFixed(4).replace(/0{1,2}$/, "")}¢`;
  return (
    <div className="space-y-2 border border-line bg-bg-soft px-4 py-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-dim">Premium for this month</span>
        <span className="num text-xl font-medium text-ink">${formatMusd(premium, 2)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-dim">Payout if triggered</span>
        <span className="num font-medium">${formatMusd(filled * PAYOUT_PER_SHARE, 2)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-dim">Collateral from risk sellers</span>
        <span className="num">${formatMusd(filled * PAYOUT_PER_SHARE - premium, 2)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-dim">Average price</span>
        <span className="num">{avgText} per $1 of cover</span>
      </div>
      {atBest !== null && filled > 0n && (
        <div className="text-xs text-dim">
          At the best offer alone ({formatCents(bestAskBps as number)}¢) this would cost ${formatMusd(atBest, 2)}. Walking the book adds ${formatMusd(slip, 2)} of
          slippage. Worst price sent: {formatPrice(preview.limitPriceBps)}.
        </div>
      )}
      {filled < requested && (
        <div className="text-xs text-warn">
          Only ${formatShares(filled)} of ${formatShares(requested)} can fill within the slippage limit right now. The rest is not sent.
        </div>
      )}
      <div className="text-xs text-dim">
        Annual equivalent at the same average price every month: ${formatMusd(premium * 12n, 2)}. Assumes full execution each month and no fees; future prices
        are set by the book.
      </div>
    </div>
  );
}

const quoteAtBps = (qty: bigint, bps: number): bigint => qty * BigInt(bps) * 100n;
