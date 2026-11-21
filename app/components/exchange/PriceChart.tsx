"use client";

// §7.3 chart: "Quoted midpoint" (best bid/ask midpoint after every event that moved it) and
// "Trades" (one point per fill at its execution price). Both come from finalized events; nothing is
// interpolated. The midpoint is drawn as steps because it only changes at events.
import { useMemo, useState } from "react";
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

export function PriceChart({ chart, outcome }: { chart: ChartInfo | undefined; outcome: OutcomeCode }) {
  const [hover, setHover] = useState<Pt | null>(null);
  const [table, setTable] = useState(false);

  const pts = useMemo(() => {
    if (!chart) return [];
    const order = (slot: number, i: number) => slot * 1_000 + i;
    const mids: Pt[] = chart.quotes
      .filter((q) => q.outcome === outcome && q.midBps !== null)
      .map((q, i) => ({ x: order(q.slot, i), kind: "mid" as const, priceBps: q.midBps as number, blockTime: q.blockTime, signature: q.signature }));
    const trades: Pt[] = chart.trades
      .filter((t) => t.outcome === outcome)
      .map((t, i) => ({ x: order(t.slot, 500 + i), kind: "trade" as const, priceBps: t.priceBps, quantity: t.quantity, blockTime: t.blockTime, signature: t.signature }));
    return [...mids, ...trades].sort((a, b) => a.x - b.x);
  }, [chart, outcome]);

  if (!chart) return <div className="h-[180px] animate-pulse bg-bg-soft" />;
  if (chart.indexing) return <div className="flex h-16 items-center text-xs text-dim">Indexing…</div>;
  if (!pts.length) return <div className="flex h-16 items-center text-xs text-dim">No chart data yet</div>;

  // Even spacing by event order: chain order is what matters, gaps in time are not data.
  const xs = pts.map((_, i) => i);
  const prices = pts.map((p) => p.priceBps);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const padBps = Math.max(20, Math.round((hi - lo) * 0.15));
  lo = Math.max(0, lo - padBps);
  hi = Math.min(10_000, hi + padBps);
  const sx = (i: number) => PAD.l + (xs.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (xs.length - 1)) * (W - PAD.l - PAD.r));
  const sy = (bps: number) => PAD.t + (1 - (bps - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];

  let path = "";
  let prevY: number | null = null;
  pts.forEach((p, i) => {
    if (p.kind !== "mid") return;
    const x = sx(i);
    const y = sy(p.priceBps);
    path += prevY === null ? `M${x},${y}` : `H${x}V${y}`;
    prevY = y;
  });
  if (prevY !== null) path += `H${sx(pts.length - 1)}`;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-dim">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3" style={{ background: MID }} /> Mid
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: TRADE }} /> Trades
          </span>
          <span className="text-faint">{outcomeName(outcome)}</span>
        </div>
        <button className="text-faint hover:text-ink" onClick={() => setTable((t) => !t)}>
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {table ? (
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
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${outcomeName(outcome)} quoted midpoint and trades`} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="#e8e7e4" strokeWidth={1} />
                <text x={PAD.l - 6} y={sy(t) + 4} textAnchor="end" fontSize={11} fill="#9a9a94" className="num">
                  {formatPrice(t)}
                </text>
              </g>
            ))}
            {path && <path d={path} fill="none" stroke={MID} strokeWidth={2} strokeLinejoin="round" />}
            {pts.map((p, i) =>
              p.kind === "trade" ? <circle key={`t${p.x}`} cx={sx(i)} cy={sy(p.priceBps)} r={4.5} fill={TRADE} stroke="#fff" strokeWidth={2} /> : null,
            )}
            {hover && (
              <line x1={sx(pts.indexOf(hover))} x2={sx(pts.indexOf(hover))} y1={PAD.t} y2={H - PAD.b} stroke="#d4d3cf" strokeWidth={1} />
            )}
            {pts.map((p, i) => (
              <rect
                key={`h${p.x}`}
                x={sx(i) - Math.max(6, (W - PAD.l - PAD.r) / pts.length / 2)}
                y={PAD.t}
                width={Math.max(12, (W - PAD.l - PAD.r) / pts.length)}
                height={H - PAD.t - PAD.b}
                fill="transparent"
                onMouseEnter={() => setHover(p)}
              />
            ))}
          </svg>
          {hover && (
            <div className="pointer-events-none absolute top-2 right-2 border border-line bg-bg px-3 py-2 text-xs shadow-sm">
              <div className="font-medium text-ink">{hover.kind === "mid" ? "Quoted midpoint" : "Trade"}</div>
              <div className="num text-ink-secondary">
                {formatPrice(hover.priceBps)} mUSD{hover.quantity !== undefined ? ` · ${formatShares(hover.quantity)} shares` : ""}
              </div>
              <div className="num text-faint">{hover.blockTime ? formatUnix(hover.blockTime) : "time pending"}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
