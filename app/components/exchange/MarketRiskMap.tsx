"use client";

import { memo, useEffect, useState } from "react";
import type { SettledMarketOverlay } from "@metrex/server";
import { PerimeterMap } from "@/components/PerimeterMap";
import type { MarketSummary } from "@/lib/exchange-client";

type Props = Pick<MarketSummary, "address" | "evidenceHash" | "latE6" | "lonE6" | "triggerDistanceM" | "outcome"> & {
  label: string;
  pointTrigger?: string;
  zoom: number;
};

const OVERLAY_LABEL = {
  wildfire: "Mapped fire perimeter",
  hurricane: "64-knot wind swaths",
  tornado: "Surveyed EF2+ centerlines",
};

export const MarketRiskMap = memo(function MarketRiskMap({
  address, evidenceHash, latE6, lonE6, triggerDistanceM, outcome, label, pointTrigger, zoom,
}: Props) {
  const settled = outcome === "yes" || outcome === "no";
  const [published, setPublished] = useState<SettledMarketOverlay>();
  const overlay = settled && published?.evidenceHash === evidenceHash ? published.overlay : undefined;

  useEffect(() => {
    if (!settled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let retry: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const response = await fetch(`/api/evidence/${address}?overlay=1`, { cache: "no-store", signal });
        if (response.ok) {
          const data: SettledMarketOverlay = await response.json();
          if (data.evidenceHash === evidenceHash) {
            if (!signal.aborted) setPublished(data);
            return;
          }
        }
      } catch {
        // Finalization and evidence publication can lag the displayed market outcome.
      }
      if (!signal.aborted) retry = setTimeout(load, 10_000);
    }

    void load();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [address, evidenceHash, settled]);

  return (
    <section id="risk-map" aria-labelledby="risk-map-title" className="scroll-mt-20 space-y-3">
      <h2 id="risk-map-title" className="text-lg font-semibold tracking-tight text-ink">Risk map</h2>
      <figure className="space-y-2">
        <PerimeterMap
          points={[{ key: address, lat: latE6 / 1e6, lon: lonE6 / 1e6, label, radiusM: triggerDistanceM || undefined, selected: true }]}
          hazardOverlay={overlay}
          zoom={zoom}
          height={340}
          showLegend={false}
        />
        <figcaption className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-dim">
          <span><span aria-hidden="true" className="mr-1 text-ink">●</span>Registered property</span>
          {triggerDistanceM > 0 ? (
            <span><span aria-hidden="true" className="mr-1 text-[#213b51]">◌</span>{triggerDistanceM.toLocaleString("en-US")} m trigger radius</span>
          ) : pointTrigger && <span>{pointTrigger}</span>}
          {overlay && overlay.kind !== "earthquake" && (
            <span><span aria-hidden="true" className="mr-1 text-[#a84022]">■</span>{OVERLAY_LABEL[overlay.kind]}</span>
          )}
          {overlay?.kind === "earthquake" && (
            <>
              <span><span aria-hidden="true" className="mr-1 text-[#416f88]">●</span>Below MMI {overlay.thresholdX10 / 10}</span>
              <span><span aria-hidden="true" className="mr-1 text-[#a84022]">●</span>MMI {overlay.thresholdX10 / 10} or higher</span>
              <span>Nearest ShakeMap node · MMI {overlay.nearest.mmi_x10 / 10}</span>
            </>
          )}
          {!overlay && (
            <span role="status">
              {settled ? "Waiting for verified historical overlay." : outcome === "invalid" ? "Historical overlay unavailable for Invalid settlement." : "Historical overlay appears after verified settlement."}
            </span>
          )}
        </figcaption>
      </figure>
    </section>
  );
});
