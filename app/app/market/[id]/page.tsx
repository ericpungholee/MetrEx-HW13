"use client";

// Market page (spec-v2 §10.3).
import { use } from "react";
import { fetchMarketInfo, fetchRound } from "@/lib/exchange-client";
import { usePoll } from "@/lib/usePoll";
import { MarketView } from "@/components/exchange/MarketView";

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const round = usePoll(
    async () => {
      const info = await fetchMarketInfo(id);
      return info ? fetchRound(info.market.round) : null;
    },
    [id],
    15_000,
  );
  return <MarketView market={id} round={round.data ?? null} />;
}
