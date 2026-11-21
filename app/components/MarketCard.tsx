"use client";

import Link from "next/link";
import type { MarketSummary } from "@/lib/derive";
import { formatBps, formatMusd, formatRatio } from "@/lib/format";
import { FundingBar, scenarioName, StatusPill } from "./ui";

/** Market listing row — title and price first, minimal metadata. */
export function MarketCard({ s }: { s: MarketSummary }) {
  const m = s.market.account;
  const best = s.bestOpenBps === null ? null : formatBps(s.bestOpenBps);

  return (
    <Link
      href={`/v1/market/${s.market.publicKey.toBase58()}`}
      className="group block border-b border-line py-6 transition-colors first:pt-0 last:border-b-0 hover:bg-bg-soft/60 sm:py-7"
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-xl font-semibold tracking-tight text-ink transition-colors group-hover:text-ink sm:text-2xl">
              {s.label}
            </h2>
            <StatusPill state={s.display} />
          </div>
          <p className="mt-1.5 text-sm text-dim">
            Within {m.triggerDistanceM} m · {scenarioName(m.scenarioId)}
          </p>
          <div className="mt-4 max-w-md">
            <FundingBar activated={s.activated} target={s.target} />
            <div className="mt-2 flex justify-between text-xs text-faint">
              <span className="num">
                {formatMusd(s.activated, 0)} of {formatMusd(s.target, 0)} mUSD
              </span>
              <span className="num">{formatRatio(s.activated, s.target)}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6 sm:w-[280px] sm:shrink-0 sm:gap-4">
          <Metric label="Coverage" value={formatMusd(s.target, 0)} />
          <Metric label="Best rate" value={best ?? "—"} emphasize={best !== null} />
          <Metric label="Offers" value={String(s.openOffers.length)} />
        </div>
      </div>
    </Link>
  );
}

function Metric({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <div className="text-xs font-medium tracking-wide text-faint uppercase">{label}</div>
      <div className={`num mt-1 text-lg tracking-tight ${emphasize ? "font-semibold text-ink" : "text-ink"}`}>{value}</div>
    </div>
  );
}
