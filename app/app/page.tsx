"use client";

// Homepage (spec-v2 §10.2): the featured market of Config.latest_round only. Earlier rounds are on
// /rounds with their outcomes labelled.
import { fetchLatestRound } from "@/lib/exchange-client";
import { FEATURED_PROPERTY } from "@/lib/env";
import { usePoll } from "@/lib/usePoll";
import { MarketView } from "@/components/exchange/MarketView";
import { Unavailable } from "@/components/exchange/Labels";

export default function Home() {
  const round = usePoll(() => fetchLatestRound(), [], 5_000);
  if (round.data === undefined) return round.error ? <Unavailable>Exchange data unavailable: {round.error}</Unavailable> : <div className="h-96 animate-pulse bg-bg-soft" />;
  if (round.data === null) return <div className="py-16 text-center text-sm text-dim">No round has been opened on this cluster yet.</div>;
  const r = round.data;
  const featured = r.markets.find((m) => m.propertyId === FEATURED_PROPERTY) ?? r.markets[0];
  if (!featured) return <div className="py-16 text-center text-sm text-dim">Round #{r.roundId.toString()} has no markets yet.</div>;
  return <MarketView market={featured.address} round={r} />;
}
