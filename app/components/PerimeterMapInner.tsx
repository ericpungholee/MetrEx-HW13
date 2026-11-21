"use client";

// Leaflet map: packaged fire perimeter + property points with their trigger circles.
// Client-only (imported through PerimeterMap with ssr: false).
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Circle, CircleMarker, GeoJSON, MapContainer, TileLayer, Tooltip, useMap } from "react-leaflet";

type GeoJsonObject = ComponentProps<typeof GeoJSON>["data"];

export interface MapPoint {
  key: string;
  lat: number;
  lon: number;
  label: string;
  /** Draw the trigger circle (metres). */
  radiusM?: number;
  selected?: boolean;
}

export const PERIMETER_URL = "/data/palisades-2025.geojson";

function FitTo({ points }: { points: MapPoint[] }) {
  const map = useMap();
  const sel = points.find((p) => p.selected) ?? points[0];
  useEffect(() => {
    if (sel) map.setView([sel.lat, sel.lon], points.some((p) => p.selected) ? 14 : 12);
  }, [map, sel?.key, sel?.lat, sel?.lon]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function PerimeterMapInner({
  points,
  height = 320,
  onSelect,
}: {
  points: MapPoint[];
  height?: number;
  onSelect?: (key: string) => void;
}) {
  const [perimeter, setPerimeter] = useState<GeoJsonObject | null>(null);
  const [perimeterState, setPerimeterState] = useState<"loading" | "ok" | "missing">("loading");

  useEffect(() => {
    let alive = true;
    fetch(PERIMETER_URL)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as GeoJsonObject;
        if (alive) {
          setPerimeter(j);
          setPerimeterState("ok");
        }
      })
      .catch(() => alive && setPerimeterState("missing"));
    return () => {
      alive = false;
    };
  }, []);

  const center = points[0] ? ([points[0].lat, points[0].lon] as [number, number]) : ([34.05, -118.53] as [number, number]);

  return (
    <div className="relative overflow-hidden rounded border border-line" style={{ height }}>
      <MapContainer center={center} zoom={12} style={{ height: "100%", width: "100%" }} scrollWheelZoom={false}>
        <TileLayer
          className="dark-tiles"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {perimeter && (
          <GeoJSON
            data={perimeter}
            style={() => ({ color: "#f0505a", weight: 1.5, fillColor: "#f0505a", fillOpacity: 0.22 })}
          />
        )}
        {points.map((p) => (
          <span key={p.key}>
            {p.radiusM !== undefined && (
              <Circle
                center={[p.lat, p.lon]}
                radius={p.radiusM}
                pathOptions={{ color: p.selected ? "#4ea1ff" : "#8592a3", weight: p.selected ? 2 : 1, dashArray: "4 4", fillOpacity: 0.08 }}
              />
            )}
            <CircleMarker
              center={[p.lat, p.lon]}
              radius={p.selected ? 6 : 4}
              pathOptions={{ color: "#fff", weight: 1, fillColor: p.selected ? "#4ea1ff" : "#d7dee8", fillOpacity: 1 }}
              eventHandlers={onSelect ? { click: () => onSelect(p.key) } : undefined}
            >
              <Tooltip>{p.label}</Tooltip>
            </CircleMarker>
          </span>
        ))}
        <FitTo points={points} />
      </MapContainer>
      <div className="pointer-events-none absolute top-2 right-2 z-[500] rounded bg-bg/85 px-2 py-1 text-[10px] text-dim">
        {perimeterState === "ok" && <span className="text-down">■</span>} Fire perimeter{" "}
        {perimeterState === "loading" ? "loading…" : perimeterState === "missing" ? "unavailable (data/ not packaged yet)" : ""}
        {points.some((p) => p.radiusM !== undefined) && (
          <>
            {" "}
            · <span className="text-info">◌</span> trigger radius
          </>
        )}
      </div>
    </div>
  );
}
