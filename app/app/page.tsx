"use client";

import Link from "next/link";
import { useMemo } from "react";
import { MarketCard } from "@/components/MarketCard";
import { NetworkPanel } from "@/components/NetworkPanel";
import { Empty, ErrorLine } from "@/components/ui";
import { fetchExchange } from "@/lib/client";
import { summarizeMarket } from "@/lib/derive";
import { usePoll } from "@/lib/usePoll";

export default function ExchangePage() {
  const ex = usePoll(fetchExchange, []);
  const summaries = useMemo(
    () => (ex.data ? ex.data.markets.map((m) => summarizeMarket(m, ex.data!.offers, ex.data!.properties)) : []),
    [ex.data],
  );
  const live = summaries.filter((s) => s.display === "Accepting offers" || s.display === "Funded");
  const settled = summaries.filter((s) => !(s.display === "Accepting offers" || s.display === "Funded"));

  return (
    <div className="space-y-5">
      <NetworkPanel />
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-bold">Exchange</h1>
          <p className="text-xs text-dim">
            Individual parametric wildfire risk. Traders underwrite with fully collateralized offers; an oracle settles from
            escrow.
          </p>
        </div>
        <Link href="/create" className="btn btn-primary">
          + Create market
        </Link>
      </div>
      <ErrorLine error={ex.error} />
      {ex.loading && <Empty>Loading markets from chain…</Empty>}
      {ex.data && summaries.length === 0 && <Empty>No markets yet. Create the first one.</Empty>}
      {live.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-dim uppercase">Open markets ({live.length})</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {live.map((s) => (
              <MarketCard key={s.market.publicKey.toBase58()} s={s} />
            ))}
          </div>
        </section>
      )}
      {settled.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-dim uppercase">Closed and settled ({settled.length})</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {settled.map((s) => (
              <MarketCard key={s.market.publicKey.toBase58()} s={s} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
