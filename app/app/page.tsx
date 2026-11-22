"use client";

// Homepage (docs/spec-multiperil.md §7.2): one property market per hazard, each from the newest round
// of its scenario. Outcome buttons use the live asks from their own on-chain books.
import Link from "next/link";
import { CATALOG, HAZARD_LABEL, Outcome, type CatalogMarket } from "@metrex/exchange";
import { fetchFeatured, fetchMarketInfo, type FeaturedMarket } from "@/lib/exchange-client";
import { formatPrice, marketState } from "@/lib/exchange-format";
import { formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { StateLabel, Unavailable } from "@/components/exchange/Labels";
import { MarketPhoto } from "@/components/exchange/MarketPhoto";

function OutcomeLink({ href, label, ask, pending, unavailable }: { href: string; label: "YES" | "NO"; ask: number | null; pending?: boolean; unavailable?: boolean }) {
  return (
    <Link
      href={`${href}?outcome=${label.toLowerCase()}`}
      prefetch={false}
      className={`flex min-h-10 flex-wrap items-center justify-between gap-x-2 rounded-md px-3 py-2 text-sm font-semibold transition-opacity hover:opacity-75 ${label === "YES" ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}
    >
      <span className={label === "YES" ? "text-up" : "text-down"}>{label}</span>
      <span className="num">{unavailable ? "Unavailable" : pending ? "…" : ask === null ? "No ask" : formatPrice(ask)}</span>
    </Link>
  );
}

function MarketCard({ c, f, loading, failed }: { c: CatalogMarket; f: FeaturedMarket | undefined; loading: boolean; failed: boolean }) {
  const address = f?.market?.address;
  const href = address ? `/market/${address}` : undefined;
  const state = f?.market && f.round ? marketState(f.market.outcome, f.round) : null;
  const info = usePoll(() => address ? fetchMarketInfo(address) : Promise.resolve(null), [address], 20_000);
  const volume = info.error ? null : info.data?.volume;
  const body = (
    <>
      <MarketPhoto photo={c.photo} sizes="(min-width: 72rem) 540px, (min-width: 40rem) 50vw, 100vw" className="aspect-[2/1] w-full sm:aspect-[9/4]" />
      <div className="flex flex-1 flex-col gap-2 p-4 sm:px-5">
        <div className="text-sm text-dim">
          {HAZARD_LABEL[c.hazard]} · {c.place}
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-ink sm:text-xl">{c.question}</h2>
        <div className="text-sm text-dim">{c.month}</div>
      </div>
    </>
  );
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line">
      {href ? (
        <Link href={href} className="flex flex-1 flex-col transition-colors hover:bg-bg-soft focus-visible:outline-offset-[-2px]">
          {body}
        </Link>
      ) : (
        <div className="flex flex-1 flex-col">{body}</div>
      )}
      <div className="space-y-2 px-4 pb-4 sm:px-5">
        {href && state === "Open" ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs text-dim">
              <span>Best asks</span>
              {volume != null && <span className="num">Vol {formatMusd(volume)} mUSD</span>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <OutcomeLink href={href} label="YES" ask={f?.yesBestAskBps ?? null} unavailable={failed} />
              <OutcomeLink href={href} label="NO" ask={f?.noBestAskBps ?? null} unavailable={failed} />
            </div>
          </>
        ) : loading ? (
          <div className="h-10 animate-pulse rounded bg-bg-soft" aria-label="Loading market status" />
        ) : (
          <div className="flex min-h-10 items-center justify-between gap-2 text-sm text-dim">
            {state ? <StateLabel state={state} /> : failed ? "Market data unavailable" : "Not listed on this cluster"}
            {volume != null && <span className="num text-xs">Vol {formatMusd(volume)} mUSD</span>}
          </div>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const featured = usePoll(() => fetchFeatured(), [], 5_000);
  const byProperty = new Map((featured.data ?? []).map((f) => [f.propertyId, f]));

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Property markets</h1>

      {featured.error && !featured.data && <Unavailable>Exchange data unavailable: {featured.error}</Unavailable>}
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
        {CATALOG.map((c) => (
          <MarketCard key={byProperty.get(c.propertyId)?.market?.address ?? c.propertyId} c={c} f={byProperty.get(c.propertyId)} loading={featured.loading} failed={!!featured.error} />
        ))}
      </div>

    </div>
  );
}
