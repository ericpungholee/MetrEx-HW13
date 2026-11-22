"use client";

// §10.3 trade panel. The preview is computed from the live book with the same planner that builds
// the transaction; before the wallet opens the transaction is simulated and a program error is
// shown in plain words. If the book moved, the whole transaction fails with nothing moved.
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OrderSide, Outcome, PAYOUT_PER_SHARE, INVALID_PAYOUT_PER_SHARE, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
import {
  bookOrders,
  buildTrade,
  previewTrade,
  sendTrade,
  USE_FIXTURES,
  type BookInfo,
  type MarketSummary,
  type TradeIntent,
} from "@/lib/exchange-client";
import { formatPrice, formatShares, outcomeName, parsePriceToBps } from "@/lib/exchange-format";
import { formatMusd } from "@/lib/format";
import { useWalletSigner } from "@/lib/useWalletSigner";
import { useTx } from "@/components/TxProvider";
import { InvalidDisclosure } from "./Labels";

function Toggle<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-1 rounded-md bg-bg-soft p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={`rounded px-2 py-2 text-sm font-medium ${value === v ? "bg-bg text-ink shadow-xs" : "text-dim hover:text-ink"}`}>
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

export type TradeMode = "coverage" | "shares";

export function TradePanel({
  market,
  book,
  outcome,
  onOutcome,
  mode,
  onMode,
  have,
  tradingOpen,
  pick,
  onDone,
}: {
  market: MarketSummary;
  book: BookInfo | undefined;
  outcome: OutcomeCode;
  onOutcome: (o: OutcomeCode) => void;
  mode: TradeMode;
  onMode: (mode: TradeMode) => void;
  have: { musd: bigint; yes: bigint; no: bigint } | null;
  tradingOpen: boolean;
  pick: TradePick | null;
  onDone: () => void;
}) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const signer = useWalletSigner();
  const { run } = useTx();
  const [coverText, setCoverText] = useState("100000");
  const [sideRaw, setSide] = useState<OrderSideCode>(OrderSide.Buy);
  const [kindRaw, setKind] = useState<"market" | "limit">("market");
  const [qtyText, setQtyText] = useState("100");
  const [priceText, setPriceText] = useState("");
  const [coverageTolerance, setCoverageTolerance] = useState("10");
  const [sharesTolerance, setSharesTolerance] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clicking a book level fills a limit order that would trade against it.
  useEffect(() => {
    if (!pick) return;
    setKind("limit");
    setSide(pick.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy);
    setPriceText(formatPrice(pick.priceBps));
  }, [pick]);

  const coverage = mode === "coverage";
  const slipText = coverage ? coverageTolerance : sharesTolerance;
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
  const validSlippage = /^\d{1,2}(?:\.\d{1,2})?$/.test(slipText.trim());
  const slippage = validSlippage ? Math.round(Number(slipText.trim()) * 100) : 0;
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
    ...(kind === "market" && !validSlippage ? ["Enter a price tolerance from 0% to 99.99%."] : []),
    ...(preview?.problems ?? []),
  ];

  useEffect(() => setError(null), [side, kind, qtyText, priceText, slipText, outcome, mode, coverText]);
  async function submit() {
    if (!publicKey || !signer || !preview || !book) return;
    setBusy(true);
    setError(null);
    try {
      const fetchedAt = Date.parse(book.fetchedAt);
      if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > 15_000) {
        onDone();
        setError("This quote has expired. Review the refreshed quote before trading.");
        return;
      }
      const built = await buildTrade(publicKey, market, rows, preview);
      const label = coverage
        ? `Buy $${formatShares(preview.filledQty)} of coverage (${formatShares(preview.filledQty)} YES)`
        : `${side === OrderSide.Buy ? "Buy" : "Sell"} ${formatShares(kind === "market" ? built.preview.filledQty : qty)} ${outcomeName(outcome)}${kind === "limit" ? ` @ ${formatPrice(preview.limitPriceBps)}` : " at market"}`;
      const res = await run(label, (opts) => sendTrade(signer, built.ixs, opts));
      if (res) onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const o = outcomeName(outcome);
  const positionQty = kind === "limit" ? qty : (preview?.filledQty ?? 0n);
  const cost = kind === "limit" ? preview?.escrow.musd : preview?.filledQuote;
  const averagePriceBps = preview && preview.filledQty > 0n
    ? Number((preview.filledQuote * 10n) / preview.filledQty) / 1_000
    : null;
  const hasQuote = preview && qty > 0n && (kind === "market" || priceBps !== null);
  const action = coverage ? "Buy coverage" : `${side === OrderSide.Buy ? "Buy" : "Sell"} ${o}`;

  return (
    <div className="space-y-3">
      <Toggle value={mode} options={[["coverage", "Buy coverage"], ["shares", "Trade shares"]]} onChange={onMode} />
      {coverage ? (
        <>
          <label className="block">
            <span className="text-sm font-medium">Coverage amount ($)</span>
            <input className="input num mt-1 w-full" inputMode="numeric" value={coverText} onChange={(e) => setCoverText(e.target.value)} />
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {["25000", "50000", "100000", "250000"].map((v) => (
              <button key={v} type="button" aria-pressed={coverDigits === v} onClick={() => setCoverText(v)} className={`rounded border px-1 py-2 text-xs ${coverDigits === v ? "border-ink text-ink" : "border-line text-dim hover:text-ink"}`}>
                {"$"}{Number(v) / 1000}k
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <Toggle value={side} options={[[OrderSide.Buy, "Buy"], [OrderSide.Sell, "Sell"]]} onChange={setSide} />
          <Toggle value={outcome} options={[[Outcome.Yes, "YES"], [Outcome.No, "NO"]]} onChange={onOutcome} />
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="text-sm font-medium">Order type</span>
              <select className="input mt-1 w-full" value={kindRaw} onChange={(e) => setKind(e.target.value === "limit" ? "limit" : "market")}>
                <option value="market">Market</option>
                <option value="limit">Limit</option>
              </select>
            </label>
            <label>
              <span className="text-sm font-medium">Shares</span>
              <input className="input num mt-1 w-full" inputMode="numeric" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
            </label>
          </div>
        </>
      )}

      {kind === "limit" && (
        <label className="block">
          <span className="text-sm font-medium">Limit price (¢ per share)</span>
          <input className="input num mt-1 w-full" placeholder="0.86" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </label>
      )}
      {tradingOpen && hasQuote && (
        <dl className="space-y-2 border-t border-line pt-3 text-sm">
          <QuoteLine label={coverage ? "Estimated monthly cost" : side === OrderSide.Sell ? "Estimated proceeds now" : kind === "limit" ? "Maximum cost / escrow" : "Estimated cost"}>
            {formatMusd(side === OrderSide.Buy ? (cost ?? 0n) : preview.filledQuote)} mUSD
          </QuoteLine>
          <QuoteLine label={side === OrderSide.Buy ? "Potential payout" : `Payout given up if ${o} wins`}>
            {formatMusd(positionQty * PAYOUT_PER_SHARE)} mUSD
          </QuoteLine>
        </dl>
      )}
      {tradingOpen && preview && qty > 0n && kind === "market" && preview.filledQty < qty && (
        <p className="text-xs text-warn">
          {coverage ? `$${formatShares(preview.filledQty)} of $${formatShares(qty)} can fill.` : `${formatShares(preview.filledQty)} of ${formatShares(qty)} shares can fill.`} The remainder stays unsubmitted.
        </p>
      )}
      {tradingOpen && qty > 0n && problems.length > 0 && <p className="text-xs text-warn">{problems[0]}</p>}
      {tradingOpen && publicKey && !signer && <p className="text-xs text-warn">This wallet cannot sign exchange transactions.</p>}
      {error && <p role="alert" className="rounded border border-down/30 bg-down-soft px-3 py-2 text-xs text-down">{error}</p>}

      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={USE_FIXTURES || !tradingOpen || busy || (!!publicKey && (!signer || !preview || problems.length > 0 || qty === 0n))}
        onClick={() => publicKey ? void submit() : setVisible(true)}
      >
        {!tradingOpen ? "Trading closed" : !publicKey ? "Connect wallet" : busy ? "Checking…" : action}
      </button>
      <InvalidDisclosure />

      {tradingOpen && (
        <details className="border-t border-line pt-2 text-xs text-dim">
          <summary className="cursor-pointer py-1 font-medium text-ink-secondary">Execution details</summary>
          <div className="mt-2 space-y-2">
            {kind === "market" && (
              <label className="block">
                <span>Price tolerance (% from best price)</span>
                <input className="input num mt-1 w-full" inputMode="decimal" value={slipText} onChange={(e) => (coverage ? setCoverageTolerance : setSharesTolerance)(e.target.value)} />
              </label>
            )}
            {hasQuote && (
              <>
                <p>{formatShares(preview.filledQty)} shares estimated to fill now{averagePriceBps !== null ? ` at ${formatPrice(averagePriceBps)} average` : ""}.</p>
                {kind === "market" ? (
                  <p>
                    Worst accepted price {formatPrice(preview.limitPriceBps)}.
                    {side === OrderSide.Buy && ` Maximum cost ${formatMusd(preview.maxSpend)} mUSD.`}
                  </p>
                ) : (
                  <>
                    <p>{formatShares(preview.restQty)} shares estimated to rest at {formatPrice(preview.limitPriceBps)}.</p>
                    {side === OrderSide.Sell && <p>Escrow {formatShares(preview.escrow.shares)} {o} shares.</p>}
                  </>
                )}
                {side === OrderSide.Buy && <p>Payout if Invalid {formatMusd(positionQty * INVALID_PAYOUT_PER_SHARE)} mUSD.</p>}
              </>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function QuoteLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-dim">{label}</dt>
      <dd className="num text-right font-semibold">{children}</dd>
    </div>
  );
}
