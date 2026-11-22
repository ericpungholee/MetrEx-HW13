"use client";

// §10.3 trade panel. The preview is computed from the live book with the same planner that builds
// the transaction; before the wallet opens the transaction is simulated and a program error is
// shown in plain words. If the book moved, the whole transaction fails with nothing moved.
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OrderSide, Outcome, PAYOUT_PER_SHARE, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
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

const MARKET_TOLERANCE_BPS = 500;

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
  const { setVisible } = useWalletModal();
  const signer = useWalletSigner();
  const { run } = useTx();
  const [side, setSide] = useState<OrderSideCode>(OrderSide.Buy);
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [qtyText, setQtyText] = useState("100");
  const [priceText, setPriceText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clicking a book level fills a limit order that would trade against it.
  useEffect(() => {
    if (!pick) return;
    setKind("limit");
    setSide(pick.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy);
    setPriceText(formatPrice(pick.priceBps));
  }, [pick]);

  const qtyDigits = qtyText.replace(/[,\s]/g, "");
  const qty = /^\d{1,7}$/.test(qtyDigits) ? BigInt(qtyDigits) : 0n;
  const priceBps = parsePriceToBps(priceText);
  // Market orders accept up to 5% from the best executable price (spec-multiperil §7.4).
  const slippage = MARKET_TOLERANCE_BPS;
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

  useEffect(() => setError(null), [side, kind, qtyText, priceText, outcome]);
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
      const label = `${side === OrderSide.Buy ? "Buy" : "Sell"} ${formatShares(kind === "market" ? built.preview.filledQty : qty)} ${outcomeName(outcome)}${kind === "limit" ? ` @ ${formatPrice(preview.limitPriceBps)}` : " at market"}`;
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
  const hasQuote = preview && qty > 0n && (kind === "market" || priceBps !== null);
  const action = `${side === OrderSide.Buy ? "Buy" : "Sell"} ${o}`;

  return (
    <div className="space-y-3">
      <Toggle value={side} options={[[OrderSide.Buy, "Buy"], [OrderSide.Sell, "Sell"]]} onChange={setSide} />
      <Toggle value={outcome} options={[[Outcome.Yes, "YES"], [Outcome.No, "NO"]]} onChange={onOutcome} />
      <Toggle value={kind} options={[["market", "Market"], ["limit", "Limit"]]} onChange={setKind} />
      <label className="block">
        <span className="text-sm font-medium">Shares</span>
        <input className="input num mt-1 w-full" inputMode="numeric" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
        <span className="mt-1 block text-xs text-dim">Each share pays 1 mUSD if {o} wins.</span>
      </label>

      {kind === "limit" && (
        <label className="block">
          <span className="text-sm font-medium">Limit price (¢ per share)</span>
          <input className="input num mt-1 w-full" placeholder="0.86" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </label>
      )}
      {tradingOpen && hasQuote && (
        <dl className="space-y-2 border-t border-line pt-3 text-sm">
          <QuoteLine label={side === OrderSide.Sell ? "Estimated proceeds now" : kind === "limit" ? "Maximum cost / escrow" : "Estimated cost"}>
            {formatMusd(side === OrderSide.Buy ? (cost ?? 0n) : preview.filledQuote)} mUSD
          </QuoteLine>
          <QuoteLine label={side === OrderSide.Buy ? "Potential payout" : `Payout given up if ${o} wins`}>
            {formatMusd(positionQty * PAYOUT_PER_SHARE)} mUSD
          </QuoteLine>
        </dl>
      )}
      {tradingOpen && preview && qty > 0n && kind === "market" && preview.filledQty < qty && (
        <p className="text-xs text-warn">
          {formatShares(preview.filledQty)} of {formatShares(qty)} shares can fill. The remainder stays unsubmitted.
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
