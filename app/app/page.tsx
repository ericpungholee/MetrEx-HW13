"use client";

// Homepage (docs/spec-multiperil.md §7.2): one property market per hazard, each from the newest round
// of its scenario. Every price is the live best YES ask on the on-chain book; with no ask the card
// says so instead of showing a number. Earlier rounds are on /rounds with their outcomes labelled.
import Link from "next/link";
import { CATALOG, HAZARD_LABEL, type CatalogMarket } from "@metrex/exchange";
import { fetchFeatured, type FeaturedMarket } from "@/lib/exchange-client";
import { formatPrice, marketState } from "@/lib/exchange-format";
import { usePoll } from "@/lib/usePoll";
import { LiquidityDisclosure, ReplayDisclosure, StateLabel, Unavailable } from "@/components/exchange/Labels";
import { MarketPhoto, MarketPhotoCredit } from "@/components/exchange/MarketPhoto";

function PriceLine({ f, loading }: { f: FeaturedMarket | undefined; loading: boolean }) {
  if (loading) return <div className="h-7 w-48 animate-pulse rounded bg-bg-soft" aria-label="Loading price" />;
  if (!f?.market || !f.round) return <div className="text-sm text-dim">Not listed on this cluster yet</div>;
  const state = marketState(f.market.outcome, f.round);
  if (state !== "Open") return <StateLabel state={state} />;
  if (f.yesBestAskBps === null) return <div className="text-sm text-dim">No YES offers right now</div>;
  return (
    <div className="num text-xl font-medium text-up">
      YES {formatPrice(f.yesBestAskBps)} <span className="text-sm font-normal text-dim">best offer per $1 of cover</span>
    </div>
  );
}

function MarketCard({ c, f, loading }: { c: CatalogMarket; f: FeaturedMarket | undefined; loading: boolean }) {
  const body = (
    <>
      <MarketPhoto photo={c.photo} sizes="(min-width: 72rem) 540px, (min-width: 40rem) 50vw, 100vw" className="aspect-[2/1] w-full sm:aspect-[5/2]" />
      <div className="flex flex-1 flex-col gap-2 p-4 sm:px-5">
        <div className="text-sm text-dim">
          {HAZARD_LABEL[c.hazard]} · {c.place}
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-ink sm:text-xl">{c.question}</h2>
        <div className="text-sm text-dim">{c.month} · Historical replay</div>
        <div className="flex-1" />
        <PriceLine f={f} loading={loading} />
      </div>
    </>
  );
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line">
      {f?.market ? (
        <Link href={`/market/${f.market.address}`} className="flex flex-1 flex-col transition-colors hover:bg-bg-soft focus-visible:outline-offset-[-2px]">
          {body}
        </Link>
      ) : (
        <div className="flex flex-1 flex-col">{body}</div>
      )}
      <div className="border-t border-line px-4 py-2 sm:px-5"><MarketPhotoCredit photo={c.photo} /></div>
    </article>
  );
}

export default function Home() {
  const featured = usePoll(() => fetchFeatured(), [], 5_000);
  const byProperty = new Map((featured.data ?? []).map((f) => [f.propertyId, f]));

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Property markets</h1>
        <ReplayDisclosure />
      </div>

      {featured.error && !featured.data && <Unavailable>Exchange data unavailable: {featured.error}</Unavailable>}
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
        {CATALOG.map((c) => (
          <MarketCard key={c.propertyId} c={c} f={byProperty.get(c.propertyId)} loading={!featured.data && !featured.error} />
        ))}
      </div>

      <div className="space-y-1.5 text-sm text-dim">
        <p>
          Addresses are real residential address points from OpenStreetMap (© OpenStreetMap contributors, ODbL), used only as locations. Every
          market pays on hazard proximity or measured intensity and says nothing about damage to any home or its residents. Photos show the surrounding regions.
        </p>
        <p>
          Prices are the current best offers from the on-chain order book, not premiums set by MetrEx and not forecasts. The market can move them at any
          time.
        </p>
        <LiquidityDisclosure />
      </div>
    </div>
  );
}
