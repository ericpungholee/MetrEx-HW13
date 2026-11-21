"use client";

import Link from "next/link";
import { useMemo } from "react";
import { MarketCard } from "@/components/MarketCard";
import { NetworkPanel } from "@/components/NetworkPanel";
import { Empty, ErrorLine, PageHeader } from "@/components/ui";
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
    <div className="animate-in space-y-10">
      <PageHeader
        title="Markets"
        description="Underwrite wildfire risk on individual properties. Fully collateralized. Settled on Solana."
        action={
          <Link href="/create" className="btn btn-primary">
            Create market
          </Link>
        }
      />

      <NetworkPanel />

      <ErrorLine error={ex.error} />
      {ex.loading && <Empty>Loading markets…</Empty>}
      {ex.data && summaries.length === 0 && (
        <Empty>
          No markets yet.{" "}
          <Link href="/create" className="text-ink underline-offset-2 hover:underline">
            Create the first one
          </Link>
          .
        </Empty>
      )}

      {live.length > 0 && (
        <section>
          <h2 className="mb-1 text-xs font-medium tracking-wide text-faint uppercase">Open · {live.length}</h2>
          <div>
            {live.map((s) => (
              <MarketCard key={s.market.publicKey.toBase58()} s={s} />
            ))}
          </div>
        </section>
      )}

      {settled.length > 0 && (
        <section>
          <h2 className="mb-1 text-xs font-medium tracking-wide text-faint uppercase">Settled · {settled.length}</h2>
          <div>
            {settled.map((s) => (
              <MarketCard key={s.market.publicKey.toBase58()} s={s} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
