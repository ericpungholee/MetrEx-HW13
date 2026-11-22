"use client";

// §7.3 chart: "Quoted midpoint" (best bid/ask midpoint after every event that moved it) and
// "Trades" (one point per fill at its execution price). Both come from finalized events; nothing is
// interpolated. The midpoint is drawn as steps because it only changes at events.
import { useEffect, useMemo, useRef, useState } from "react";
import type { OutcomeCode } from "@metrex/exchange";
import type { ChartInfo } from "@/lib/exchange-client";
import { formatPrice, formatShares, outcomeName } from "@/lib/exchange-format";
import { formatUnix } from "@/lib/format";

const MID = "#2a78d6";
const TRADE = "#eb6834";
const W = 640;
const H = 220;
const PAD = { l: 52, r: 12, t: 12, b: 26 };

interface Pt {
  x: number;
  kind: "mid" | "trade";
  priceBps: number;
  quantity?: bigint;
  blockTime: number | null;
  signature: string;
}

const RANGES = [["1H", 3_600], ["24H", 86_400], ["All", null]] as const;

function LatestFill({ point, y }: { point: Pt; y: number }) {
  const ring = useRef<SVGCircleElement>(null);
  const previous = useRef(point.signature);
  useEffect(() => {
    const changed = previous.current !== point.signature;
    previous.current = point.signature;
    if (!changed || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const pulse = ring.current?.animate(
      [{ transform: "scale(1)", opacity: 0.6 }, { transform: "scale(3)", opacity: 0 }],
      { duration: 850, easing: "ease-out" },
    );
    return () => pulse?.cancel();
  }, [point.signature]);
  return (
    <g transform={`translate(${PAD.l} ${y})`} fill={TRADE}>
      <title>Latest finalized trade</title>
      <circle ref={ring} r={4} opacity={0} />
      <circle r={4} />
    </g>
  );
}

export function PriceChart({ chart, outcome, unavailable }: { chart: ChartInfo | undefined; outcome: OutcomeCode; unavailable?: boolean }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [series, setSeries] = useState<"trade" | "mid">("trade");
  const [range, setRange] = useState<(typeof RANGES)[number][1]>(null);

  const pts = useMemo(() => {
    if (!chart) return [];
    const cutoff = range === null ? null : Date.now() / 1000 - range;
    const inRange = (p: { blockTime: number | null }) => cutoff === null || (p.blockTime !== null && p.blockTime >= cutoff);
    const order = (slot: number, i: number) => slot * 1_000 + i;
    const mids: Pt[] = chart.quotes
      .filter((q) => q.outcome === outcome && q.midBps !== null && inRange(q))
      .map((q, i) => ({ x: order(q.slot, i), kind: "mid" as const, priceBps: q.midBps as number, blockTime: q.blockTime, signature: q.signature }));
    const trades: Pt[] = chart.trades
      .filter((t) => t.outcome === outcome && inRange(t))
      .map((t, i) => ({ x: order(t.slot, 500 + i), kind: "trade" as const, priceBps: t.priceBps, quantity: t.quantity, blockTime: t.blockTime, signature: t.signature }));
    return (series === "trade" ? trades : mids).sort((a, b) => a.x - b.x);
  }, [chart, outcome, range, series]);

  const hover = hoverIndex === null ? undefined : pts[hoverIndex];
  const last = pts.at(-1);
  const first = pts[0];
  const change = first && last && pts.length > 1 ? last.priceBps - first.priceBps : null;
  const maxQty = pts.reduce((max, p) => p.quantity !== undefined && p.quantity > max ? p.quantity : max, 0n);

  // Even spacing by event order: chain order is what matters, gaps in time are not data.
  let lo = pts.reduce((min, p) => Math.min(min, p.priceBps), pts.length ? 10_000 : 0);
  let hi = pts.reduce((max, p) => Math.max(max, p.priceBps), pts.length ? 0 : 10_000);
  const padBps = Math.max(20, Math.round((hi - lo) * 0.15));
  lo = Math.max(0, lo - padBps);
  hi = Math.min(10_000, hi + padBps);
  const sx = (i: number) => {
    const offset = series === "trade" ? pts.length - 1 - i : i;
    return PAD.l + offset / Math.max(1, pts.length - 1) * (W - PAD.l - PAD.r);
  };
  const sy = (bps: number) => PAD.t + (1 - (bps - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];

  const path = pts.map((p, i) => {
    const x = sx(i);
    const y = sy(p.priceBps);
    if (i === 0) return `M${x},${y}`;
    return series === "trade" ? `L${x},${y}` : `H${x}V${y}`;
  }).join(" ");

  return (
    <section aria-label={`${outcomeName(outcome)} price history`} className="rounded-md border border-line px-3 pt-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 text-xs text-dim">
        <div className="flex items-center gap-2">
          <button type="button" aria-pressed={series === "trade"} onClick={() => { setSeries("trade"); setHoverIndex(null); }} className={`rounded px-2 py-1.5 ${series === "trade" ? "bg-bg-muted font-medium text-ink" : "hover:text-ink"}`}>Trades</button>
          <button type="button" aria-pressed={series === "mid"} onClick={() => { setSeries("mid"); setHoverIndex(null); }} className={`rounded px-2 py-1.5 ${series === "mid" ? "bg-bg-muted font-medium text-ink" : "hover:text-ink"}`}>Quoted midpoint</button>
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map(([label, seconds]) => (
            <button key={label} type="button" aria-pressed={range === seconds} onClick={() => { setRange(seconds); setHoverIndex(null); }} className={`rounded px-2 py-1.5 ${range === seconds ? "bg-bg-muted font-medium text-ink" : "hover:text-ink"}`}>{label}</button>
          ))}
          {pts.length > 0 && <button type="button" aria-pressed={table} className="px-2 py-1.5 hover:text-ink" onClick={() => setTable((t) => !t)}>{table ? "Chart" : "Table"}</button>}
        </div>
      </div>
      {pts.length > 0 && chart?.indexing && <p className="pt-2 text-xs text-dim">Earlier history is indexing.</p>}
      {change !== null && (
        <p className="num pt-2 text-xs text-dim">
          {change > 0 ? "+" : change < 0 ? "−" : ""}{formatPrice(Math.abs(change))} across shown {series === "trade" ? "trades" : "quotes"}
        </p>
      )}
      {!pts.length ? (
        <div className="grid min-h-40 place-items-center text-center text-sm text-dim">
          {unavailable ? "Price history unavailable." : !chart ? "Loading price history…" : chart.indexing ?
            (series === "trade" ? "Waiting for indexed fills…" : "Earlier quote history is indexing…") :
            series === "trade" ? (range === null ? "No finalized trades yet." : "No finalized trades in this period.") :
              (range === null ? "No quoted midpoint history yet." : "No quotes in this period.")}
        </div>
      ) : table ? (
        <div className="max-h-[220px] overflow-auto border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-bg-soft text-left text-xs text-faint">
              <tr>
                <th className="px-3 py-1.5 font-medium">Series</th>
                <th className="px-3 py-1.5 text-right font-medium">Price</th>
                <th className="px-3 py-1.5 text-right font-medium">Shares</th>
                <th className="px-3 py-1.5 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {pts.map((p) => (
                <tr key={`${p.kind}-${p.x}`} className="border-t border-line">
                  <td className="px-3 py-1.5">{p.kind === "mid" ? "Quoted midpoint" : "Trade"}</td>
                  <td className="num px-3 py-1.5 text-right">{formatPrice(p.priceBps)}</td>
                  <td className="num px-3 py-1.5 text-right">{p.quantity !== undefined ? formatShares(p.quantity) : "—"}</td>
                  <td className="num px-3 py-1.5 text-right text-dim">{p.blockTime ? formatUnix(p.blockTime) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${outcomeName(outcome)} ${series === "trade" ? "finalized trades" : "quoted midpoint history"}`} onMouseLeave={() => setHoverIndex(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="#e8e7e4" strokeWidth={1} />
                <text x={PAD.l - 6} y={sy(t) + 4} textAnchor="end" fontSize={11} fill="#9a9a94" className="num">
                  {formatPrice(t)}
                </text>
              </g>
            ))}
            {path && <path d={path} fill="none" stroke={series === "trade" ? TRADE : MID} strokeWidth={2} strokeLinejoin="round" />}
            {pts.map((p, i) => p.kind === "trade" && (
              <g key={`t${p.x}`}>
                {p.quantity !== undefined && maxQty > 0n && <rect x={sx(i) - 2} y={H - PAD.b - Number(p.quantity * 18n / maxQty)} width={4} height={Number(p.quantity * 18n / maxQty)} fill={TRADE} opacity={0.25} />}
                {pts.length <= 30 && <circle cx={sx(i)} cy={sy(p.priceBps)} r={3} fill={TRADE} />}
              </g>
            ))}
            {series === "trade" && last && (
              <>
                <LatestFill key={outcome} point={last} y={sy(last.priceBps)} />
                <text x={PAD.l} y={H - 7} fontSize={11} fill="#777">Latest fill</text>
              </>
            )}
            {hover && hoverIndex !== null && (
              <line x1={sx(hoverIndex)} x2={sx(hoverIndex)} y1={PAD.t} y2={H - PAD.b} stroke="#d4d3cf" strokeWidth={1} />
            )}
            {pts.map((p, i) => (
              <rect
                key={`h${p.x}`}
                x={sx(i) - Math.max(6, (W - PAD.l - PAD.r) / pts.length / 2)}
                y={PAD.t}
                width={Math.max(12, (W - PAD.l - PAD.r) / pts.length)}
                height={H - PAD.t - PAD.b}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(i)}
              />
            ))}
          </svg>
          {hover && (
            <div className="pointer-events-none absolute top-2 right-2 border border-line bg-bg px-3 py-2 text-xs shadow-sm">
              <div className="font-medium text-ink">{hover.kind === "mid" ? "Quoted midpoint" : "Trade"}</div>
              <div className="num text-ink-secondary">
                {formatPrice(hover.priceBps)}{hover.quantity !== undefined ? ` · ${formatShares(hover.quantity)} shares` : ""}
              </div>
              <div className="num text-faint">{hover.blockTime ? formatUnix(hover.blockTime) : "time pending"}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
