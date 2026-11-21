"use client";

import Link from "next/link";
import type { MarketSummary } from "@/lib/derive";
import { formatBps, formatMusd, formatRatio } from "@/lib/format";
import { FundingBar, ReplayLabel, scenarioName, StatusPill } from "./ui";

/** Market card (spec §3.3): label — trigger; requested · funded · best premium · offers · status. */
export function MarketCard({ s }: { s: MarketSummary }) {
  const m = s.market.account;
  return (
    <Link
      href={`/market/${s.market.publicKey.toBase58()}`}
      className="block rounded border border-line bg-panel p-3 transition hover:border-dim"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{s.label}</div>
          <div className="text-xs text-dim">
            Wildfire within {m.triggerDistanceM} m · {scenarioName(m.scenarioId)}
          </div>
        </div>
        <StatusPill state={s.display} />
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        <Cell label="Requested" value={formatMusd(s.target, 0)} />
        <Cell label="Funded" value={formatMusd(s.activated, 0)} />
        <Cell label="Best premium" value={s.bestOpenBps === null ? "—" : formatBps(s.bestOpenBps)} />
        <Cell label="Offers" value={String(s.openOffers.length)} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <FundingBar activated={s.activated} target={s.target} />
        <span className="num w-12 text-right text-[11px] text-dim">{formatRatio(s.activated, s.target)}</span>
      </div>
      <div className="mt-2">
        <ReplayLabel />
      </div>
    </Link>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-faint uppercase">{label}</div>
      <div className="num text-sm">{value}</div>
    </div>
  );
}
