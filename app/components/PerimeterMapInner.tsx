"use client";

// Property points, trigger circles, and verified historical hazard layers.
// Client-only (imported through PerimeterMap with ssr: false).
import { Fragment, useEffect, useMemo, useState, type ComponentProps } from "react";
import { circleMarker } from "leaflet";
import { Circle, CircleMarker, GeoJSON, MapContainer, Pane, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { SettledMarketOverlay } from "@metrex/server";

type GeoJsonObject = ComponentProps<typeof GeoJSON>["data"];
type HazardOverlay = SettledMarketOverlay["overlay"];

const HAZARD_COLOR = "#a84022";
const LOW_INTENSITY_COLOR = "#416f88";

export interface MapPoint {
  key: string;
  lat: number;
  lon: number;
  label: string;
  /** Draw the trigger circle (metres). */
  radiusM?: number;
  selected?: boolean;
}

function FitTo({ points, zoom }: { points: MapPoint[]; zoom?: number }) {
  const map = useMap();
  const selected = points.find((p) => p.selected);
  const { lat, lon } = selected ?? points[0] ?? {};
  const fitZoom = zoom ?? (selected ? 14 : 12);
  useEffect(() => {
    if (lat !== undefined && lon !== undefined) map.setView([lat, lon], fitZoom);
  }, [map, lat, lon, fitZoom]);
  return null;
}

function IntensityGrid({ nodes, nearest, thresholdX10 }: Extract<HazardOverlay, { kind: "earthquake" }>) {
  const grid = useMemo(() => {
    const above: number[][] = [];
    const below: number[][] = [];
    for (const [lon, lat, mmi] of nodes) {
      (mmi >= thresholdX10 ? above : below).push([lon / 10_000, lat / 10_000]);
    }
    return {
      type: "FeatureCollection" as const,
      features: [
        { type: "Feature" as const, properties: { color: LOW_INTENSITY_COLOR }, geometry: { type: "MultiPoint" as const, coordinates: below } },
        { type: "Feature" as const, properties: { color: HAZARD_COLOR }, geometry: { type: "MultiPoint" as const, coordinates: above } },
      ],
    };
  }, [nodes, thresholdX10]);
  return (
    <>
      <GeoJSON
        data={grid}
        pointToLayer={(feature, latlng) => circleMarker(latlng, {
          radius: 3, stroke: false, fillColor: feature.properties.color, fillOpacity: 0.65, interactive: false,
        })}
      />
      <CircleMarker
        center={[nearest.node_lat_e4 / 10_000, nearest.node_lon_e4 / 10_000]}
        radius={6}
        pathOptions={{ color: "#fff", weight: 2, fillColor: nearest.mmi_x10 >= thresholdX10 ? HAZARD_COLOR : LOW_INTENSITY_COLOR, fillOpacity: 1 }}
      >
        <Tooltip>Nearest ShakeMap node · MMI {nearest.mmi_x10 / 10}</Tooltip>
      </CircleMarker>
    </>
  );
}

export default function PerimeterMapInner({
  points,
  height = 320,
  onSelect,
  settledMarket,
  hazardOverlay,
  zoom,
  showLegend = true,
}: {
  points: MapPoint[];
  height?: number;
  settledMarket?: string;
  onSelect?: (key: string) => void;
  hazardOverlay?: HazardOverlay;
  zoom?: number;
  showLegend?: boolean;
}) {
  const [overlay, setOverlay] = useState<{ market: string; data: GeoJsonObject | null }>();
  const perimeter = settledMarket && overlay?.market === settledMarket ? overlay.data : null;

  useEffect(() => {
    if (!settledMarket) return;
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const response = await fetch(`/api/evidence/${settledMarket}?perimeter=1`, {
          cache: "no-store", signal: abort.signal,
        });
        if (response.ok) {
          const data = await response.json() as GeoJsonObject;
          if (settledMarket && !abort.signal.aborted) setOverlay({ market: settledMarket, data });
          return;
        }
      } catch {
        // Settlement or publication can still be pending.
      }
      if (!abort.signal.aborted) retry = setTimeout(load, 10_000);
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(retry);
    };
  }, [settledMarket]);

  const center = points[0] ? ([points[0].lat, points[0].lon] as [number, number]) : ([34.05, -118.53] as [number, number]);

  return (
    <div className="relative isolate overflow-hidden border border-line" style={{ height }}>
      <MapContainer center={center} zoom={zoom ?? 12} style={{ height: "100%", width: "100%" }} scrollWheelZoom={false} preferCanvas>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {perimeter && (
          <GeoJSON
            key={settledMarket}
            data={perimeter}
            style={() => ({ color: "#c4352d", weight: 1.5, fillColor: "#c4352d", fillOpacity: 0.18 })}
          />
        )}
        {hazardOverlay && (
          <Pane name="hazard" style={{ zIndex: 390 }}>
            {hazardOverlay.kind === "earthquake" ? <IntensityGrid {...hazardOverlay} /> : (
              <GeoJSON
                data={hazardOverlay.geometry}
                style={{ color: HAZARD_COLOR, weight: hazardOverlay.kind === "tornado" ? 3 : 1.5, fillOpacity: 0.24, interactive: false }}
              />
            )}
          </Pane>
        )}
        {points.map((p) => (
          <Fragment key={p.key}>
            {p.radiusM !== undefined && (
              <Circle
                center={[p.lat, p.lon]}
                radius={p.radiusM}
                pathOptions={{ color: p.selected ? "#213b51" : "#9a9a94", weight: p.selected ? 2 : 1, dashArray: "5 4", fillOpacity: p.selected ? 0.11 : 0.04, interactive: false }}
              />
            )}
            <CircleMarker
              center={[p.lat, p.lon]}
              radius={p.selected ? 6 : 4}
              pathOptions={{ color: "#fff", weight: 1.5, fillColor: p.selected ? "#0a0a0a" : "#6b6b66", fillOpacity: 1 }}
              eventHandlers={onSelect ? { click: () => onSelect(p.key) } : undefined}
            >
              <Tooltip>{p.label}</Tooltip>
            </CircleMarker>
          </Fragment>
        ))}
        <FitTo points={points} zoom={zoom} />
      </MapContainer>
      {showLegend && (
        <div className="pointer-events-none absolute top-3 right-3 z-[500] bg-bg/90 px-2.5 py-1.5 text-xs text-dim">
          {perimeter && <span className="text-down">■ Settled footprint </span>}
          {points.some((p) => p.radiusM !== undefined) && <span>◌ Trigger radius</span>}
        </div>
      )}
    </div>
  );
}
