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
import { formatPrice, formatShares, outcomeName, parsePriceToBps } from "@/lib/exchange-format";
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
  const [side, setSide] = useState<OrderSideCode>(OrderSide.Buy);
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [qtyText, setQtyText] = useState("100");
  const [priceText, setPriceText] = useState("");
  const [slipText, setSlipText] = useState("200");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clicking a book level fills a limit order that would trade against it.
  useEffect(() => {
    if (!pick) return;
    setKind("limit");
    setSide(pick.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy);
    setPriceText(formatPrice(pick.priceBps));
  }, [pick]);

  const qty = /^\d{1,7}$/.test(qtyText.trim()) ? BigInt(qtyText.trim()) : 0n;
  const priceBps = parsePriceToBps(priceText);
  const slippage = /^\d{1,4}$/.test(slipText.trim()) ? Number(slipText.trim()) : 200;
  const me = publicKey?.toBase58() ?? "";
  const rows = useMemo(() => (book ? bookOrders(book) : []), [book]);
  const intent: TradeIntent = { outcome, side, kind, quantity: qty, priceBps: priceBps ?? undefined, slippageBps: slippage };
  const shares = have ? (outcome === Outcome.Yes ? have.yes : have.no) : 0n;
  // Without a wallet there is no balance to check: preview the fills only.
  const unlimited = 2n ** 63n;
  const balances = publicKey ? { musd: have?.musd ?? 0n, shares } : { musd: unlimited, shares: unlimited };
  const preview = book ? previewTrade(rows, intent, me, balances) : null;
  const problems = [
    ...(kind === "limit" && priceBps === null ? ["Enter a limit price in mUSD, for example 0.0410."] : []),
    ...(preview?.problems ?? []),
  ];

  useEffect(() => setError(null), [side, kind, qtyText, priceText, slipText, outcome]);

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
      const label = `${side === OrderSide.Buy ? "Buy" : "Sell"} ${formatShares(qty)} ${outcomeName(outcome)}${kind === "limit" ? ` @ ${formatPrice(preview.limitPriceBps)}` : " at market"}`;
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
    <div className="space-y-4">
      <Toggle value={side} options={[[OrderSide.Buy, "Buy"], [OrderSide.Sell, "Sell"]]} onChange={setSide} />
      <Toggle value={outcome} options={[[Outcome.Yes, "YES"], [Outcome.No, "NO"]]} onChange={onOutcome} />
      <Toggle value={kind} options={[["market", "Market"], ["limit", "Limit"]]} onChange={setKind} />

      <label className="block">
        <span className="text-xs font-medium tracking-wide text-faint uppercase">Shares</span>
        <input className="input num mt-1 w-full" inputMode="numeric" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
      </label>
      {kind === "limit" ? (
        <label className="block">
          <span className="text-xs font-medium tracking-wide text-faint uppercase">Limit price (mUSD per share)</span>
          <input className="input num mt-1 w-full" placeholder="0.0410" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </label>
      ) : (
        <label className="block">
          <span className="text-xs font-medium tracking-wide text-faint uppercase">Slippage (bps from the best price)</span>
          <input className="input num mt-1 w-full" inputMode="numeric" value={slipText} onChange={(e) => setSlipText(e.target.value)} />
        </label>
      )}

      {preview && qty > 0n && (
        <div className="space-y-1.5 border border-line bg-bg-soft px-4 py-3 text-sm">
          {preview.filledQty > 0n ? (
            <div>
              <span className="num font-medium">{formatShares(preview.filledQty)}</span> fill now at an average of{" "}
              <span className="num font-medium">{formatMusd(preview.avgPerShare ?? 0n, 4)}</span>
              {kind === "market" && <span className="text-dim"> (worst {formatPrice(preview.limitPriceBps)})</span>}
            </div>
          ) : (
            <div className="text-dim">Nothing fills now{kind === "limit" ? "." : " within the worst price."}</div>
          )}
          {kind === "limit" && preview.restQty > 0n && (
            <div>
              <span className="num font-medium">{formatShares(preview.restQty)}</span> rest at {formatPrice(preview.limitPriceBps)}
            </div>
          )}
          {kind === "market" && preview.restQty > 0n && preview.filledQty > 0n && <div className="text-dim">{formatShares(preview.restQty)} can't fill within the worst price and won't be sent.</div>}
          {kind === "limit" && (
            <div className="text-dim">
              Escrow at placement: {side === OrderSide.Buy ? <span className="num">{formatMusd(preview.escrow.musd)} mUSD</span> : <span className="num">{formatShares(preview.escrow.shares)} {o}</span>}
            </div>
          )}
          {side === OrderSide.Buy ? (
            <div className="num text-dim">
              Cost {formatMusd(kind === "limit" ? preview.escrow.musd : preview.filledQuote)} mUSD · max payout {formatMusd(kind === "limit" ? payout : preview.filledQty * PAYOUT_PER_SHARE)} mUSD (
              {formatMusd(kind === "limit" ? invalidPayout : preview.filledQty * INVALID_PAYOUT_PER_SHARE)} on invalid) · max loss the cost
            </div>
          ) : (
            <div className="text-dim">
              Receive <span className="num">{formatMusd(preview.filledQuote)} mUSD</span> now{kind === "limit" && preview.restQty > 0n ? ", more as the rest fills" : ""}. These shares would pay{" "}
              {formatShares(kind === "limit" ? qty : preview.filledQty)} mUSD if {o} wins.
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && qty > 0n && <div className="text-sm text-warn">{problems[0]}</div>}
      {error && <div className="border border-down/30 bg-down-soft px-4 py-3 text-sm text-down">{error}</div>}

      <button
        type="button"
        className={`btn w-full ${side === OrderSide.Buy ? "btn-up" : "btn-down"}`}
        disabled={USE_FIXTURES || !publicKey || !tradingOpen || busy || !preview || problems.length > 0 || qty === 0n}
        onClick={submit}
      >
        {!publicKey ? "Connect a wallet to trade" : !tradingOpen ? "Trading has closed" : busy ? "Checking…" : `${side === OrderSide.Buy ? "Buy" : "Sell"} ${o}`}
      </button>
      <InvalidDisclosure />
    </div>
  );
}
