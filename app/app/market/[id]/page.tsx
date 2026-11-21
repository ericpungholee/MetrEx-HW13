"use client";

// Market page (spec-v2 §10.3).
import { use } from "react";
import { Outcome } from "@metrex/exchange";
import { MarketView } from "@/components/exchange/MarketView";

export default function MarketPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ outcome?: string | string[] }>;
}) {
  const { id } = use(params);
  const { outcome } = use(searchParams);
  const initialOutcome = outcome === "yes" ? Outcome.Yes : outcome === "no" ? Outcome.No : undefined;
  return <MarketView key={`${id}:${initialOutcome ?? "coverage"}`} market={id} initialOutcome={initialOutcome} />;
}
