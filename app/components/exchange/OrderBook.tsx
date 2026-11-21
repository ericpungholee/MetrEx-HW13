"use client";

// §10.3 book: aggregated levels per outcome, best bid and ask, spread and depth. Every level is
// resting on-chain orders with escrow; the opposite outcome's complement is never shown as a quote.
import { useContext } from "react";
import { OrderSide, type OrderSideCode, type OutcomeCode } from "@metrex/exchange";
import type { BookSide, LevelInfo } from "@/lib/exchange-client";
import { formatPrice, formatShares, outcomeName } from "@/lib/exchange-format";
import { explorerAddress, shortKey } from "@/lib/format";
import { MakersContext } from "./Labels";

function makersOf(l: LevelInfo, makers: Map<string, string>, me: string | null): string {
  const names = l.orders.map((o) => (o.maker === me ? "You" : makers.has(o.maker) ? makers.get(o.maker)! : "User"));
  return [...new Set(names)].join(" · ");
}

function Row({ l, side, maxQty, onPick, me }: { l: LevelInfo; side: OrderSideCode; maxQty: bigint; onPick?: (priceBps: number, side: OrderSideCode) => void; me: string | null }) {
  const makers = useContext(MakersContext);
  const pct = maxQty === 0n ? 0 : Number((l.quantity * 100n) / maxQty);
  const mine = me !== null && l.orders.some((o) => o.maker === me);
  const price = formatPrice(l.priceBps);
  const makerNames = makersOf(l, makers, me);
  return (
    <div className="relative grid grid-cols-[1fr_1fr_1.2fr] items-start px-3 text-sm hover:bg-bg-soft">
      <span className={`pointer-events-none absolute inset-y-0.5 right-0 ${side === OrderSide.Buy ? "bg-up-soft" : "bg-down-soft"}`} style={{ width: `${pct}%` }} aria-hidden />
      <button
        type="button"
        onClick={() => onPick?.(l.priceBps, side)}
        className="relative col-span-2 grid grid-cols-2 py-1.5 text-left"
        title={`Use ${price} as limit price`}
      >
        <span className={`num font-medium ${side === OrderSide.Buy ? "text-up" : "text-down"}`}>{price}</span>
        <span className="num text-right text-ink">{formatShares(l.quantity)}</span>
      </button>
      <details className="relative py-1.5 text-right text-xs leading-5">
        <summary className={`cursor-pointer ${mine ? "font-medium text-ink" : "text-dim"}`} aria-label={`Orders at ${price}, makers ${makerNames}`}>
          {makerNames}
        </summary>
        <ul className="space-y-1 pt-1">
          {l.orders.map((order) => (
            <li key={order.address}>
              <a href={explorerAddress(order.address)} target="_blank" rel="noreferrer" className="text-info hover:underline" title={order.address}>
                Order {shortKey(order.address)} on Explorer
              </a>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function OrderBook({
  book,
  outcome,
  onOutcome,
  onPick,
  me,
  closed,
}: {
  book: BookSide | undefined;
  outcome: OutcomeCode;
  onOutcome: (o: OutcomeCode) => void;
  onPick?: (priceBps: number, side: OrderSideCode) => void;
  me: string | null;
  closed: boolean;
}) {
  const asks = book ? [...book.asks].reverse() : [];
  const bids = book?.bids ?? [];
  const maxQty = [...asks, ...bids].reduce((m, l) => (l.quantity > m ? l.quantity : m), 0n);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="inline-flex border border-line" role="tablist">
          {([0, 1] as OutcomeCode[]).map((o) => (
            <button
              key={o}
              role="tab"
              aria-selected={outcome === o}
              onClick={() => onOutcome(o)}
              className={`px-4 py-1.5 text-sm ${outcome === o ? "bg-ink text-bg" : "text-dim hover:text-ink"}`}
            >
              {outcomeName(o)}
            </button>
          ))}
        </div>
        {book && (
          <div className="num text-xs text-dim">
            Spread {book.spreadBps === null ? "—" : formatPrice(book.spreadBps)} · depth {formatShares(book.bidDepth)} / {formatShares(book.askDepth)}
          </div>
        )}
      </div>
      <div className="grid grid-cols-[1fr_1fr_1.2fr] border-b border-line px-3 pb-1.5 text-xs font-medium text-faint">
        <span>Price (mUSD)</span>
        <span className="text-right">Shares</span>
        <span className="text-right">Makers</span>
      </div>
      {!book ? (
        <div className="h-48 animate-pulse bg-bg-soft" />
      ) : closed ? (
        <div className="py-10 text-center text-sm text-dim">Trading has closed for this round. Resting orders are being returned to their makers.</div>
      ) : (
        <>
          <div className="pt-1">{asks.length ? asks.map((l) => <Row key={`a${l.priceBps}`} l={l} side={OrderSide.Sell} maxQty={maxQty} onPick={onPick} me={me} />) : <div className="px-3 py-3 text-sm text-faint">No asks</div>}</div>
          <div className="num my-1 border-y border-line bg-bg-soft px-3 py-1.5 text-xs text-dim">
            Best bid {formatPrice(book.bestBidBps)} · best ask {formatPrice(book.bestAskBps)}
          </div>
          <div className="pb-1">{bids.length ? bids.map((l) => <Row key={`b${l.priceBps}`} l={l} side={OrderSide.Buy} maxQty={maxQty} onPick={onPick} me={me} />) : <div className="px-3 py-3 text-sm text-faint">No bids</div>}</div>
        </>
      )}
    </div>
  );
}
