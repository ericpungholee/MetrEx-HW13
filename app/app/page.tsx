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
    <div className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:gap-6">
      {/* eslint-disable-next-line @next/next/no-img-element -- static local illustration */}
      <img src={c.photo.src} alt={c.photo.alt} className="h-36 w-full shrink-0 rounded-2xl object-cover sm:h-32 sm:w-44" />
      <div className="min-w-0 space-y-1.5">
        <div className="text-sm text-dim">
          {c.place} · {HAZARD_LABEL[c.hazard]}
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-ink sm:text-xl">{c.question}</h2>
        <div className="text-[15px] text-ink-secondary">Trigger: {c.trigger}</div>
        <PriceLine f={f} loading={loading} />
        <div className="text-sm text-dim">{c.month} contract · historical replay</div>
      </div>
    </div>
  );
  return f?.market ? (
    <Link href={`/market/${f.market.address}`} className="block border-b border-line px-1 transition-colors last:border-b-0 hover:bg-bg-soft">
      {body}
    </Link>
  ) : (
    <div className="border-b border-line px-1 opacity-70 last:border-b-0">{body}</div>
  );
}

export default function Home() {
  const featured = usePoll(() => fetchFeatured(), [], 5_000);
  const byProperty = new Map((featured.data ?? []).map((f) => [f.propertyId, f]));

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Property markets</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-ink-secondary">
          One exchange, four perils. Each market asks one yes-or-no question about one property and one calendar month. YES pays 1 mUSD per share if
          the trigger is met, so buying YES is parametric protection that pays on the event, not on damage. NO holders put up the collateral and earn the
          premium. Every YES and NO pair is backed by exactly 1 mUSD in that market&apos;s own vault.
        </p>
        <ReplayDisclosure />
      </div>

      {featured.error && !featured.data && <Unavailable>Exchange data unavailable: {featured.error}</Unavailable>}
      <div className="rounded-3xl border border-line px-4 sm:px-6">
        {CATALOG.map((c) => (
          <MarketCard key={c.propertyId} c={c} f={byProperty.get(c.propertyId)} loading={!featured.data && !featured.error} />
        ))}
      </div>

      <div className="space-y-1.5 text-sm text-dim">
        <p>
          Addresses are real residential address points from OpenStreetMap (© OpenStreetMap contributors, ODbL), used only as locations. Every
          market pays on hazard proximity or measured intensity and says nothing about damage to any home or its residents. Illustrations are
          not the property.
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
