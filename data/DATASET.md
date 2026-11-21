# Dataset: Palisades Fire, January 2025 (scenario 1)

Spec: `docs/spec.md` §8.1–§8.3. Registry: `data/scenarios.json`.

## Source

| | |
|---|---|
| Publisher | National Interagency Fire Center (NIFC), WFIGS Interagency Perimeters |
| Service | `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0` |
| Query | `query?where=OBJECTID=36398&outFields=*&outSR=4326&f=geojson` (`OBJECTID=36398`, `outSR=4326`, `f=geojson`) |
| Retrieved | 2026-11-20 |
| Feature | `OBJECTID` 36398, incident "Palisades", unique fire ID `2025-CALFD-000738`, IRWIN ID `{A7EA5D21-F882-44B8-BF64-44AB11059DC1}` |
| Size | 23,448 GIS acres (`poly_GISAcres`), map method "IR Image Interpretation" |
| Raw file | `data/raw/wfigs-palisades-2025.geojson` |

Licence / attribution: WFIGS perimeters are published openly by NIFC through its Open Data
portal as U.S. interagency government wildfire data. We redistribute the geometry unmodified and
attribute it as "Fire perimeter: NIFC WFIGS Interagency Perimeters". Check the NIFC Open Data
terms before any use beyond this hackathon demo. Perimeters are operational mapping products and
may differ from later official final perimeters; the dataset here is frozen and fingerprinted, so
any later agency revision has no effect (§8.6).

No live data is fetched at runtime. The oracle loads only the packaged, hash-verified file.

## Fingerprints (SHA-256)

| File | SHA-256 |
|---|---|
| `data/raw/wfigs-palisades-2025.geojson` (raw, 390,394 bytes) | `a88cb3a7785ad1b108c3edc84ddb948885a5a03c291e18a28e3d16a0bb45c6ba` |
| `data/palisades-2025.geojson` (normalized, 386,470 bytes) = `dataset_sha256` | `8447bc02b2789c45d278327b4997789fb42112e457715b30847b2cbd64073b4a` |

Verify: `shasum -a 256 data/raw/wfigs-palisades-2025.geojson data/palisades-2025.geojson`.

## Normalization

Reproduce with `pnpm tsx scripts/normalize-perimeter.ts` (idempotent; refuses a raw file whose
SHA-256 differs from the value above).

1. Check the raw SHA-256, that the file is a FeatureCollection with one feature, CRS EPSG:4326,
   `OBJECTID` 36398 and unique fire ID `2025-CALFD-000738`.
2. Take the geometry as a single `MultiPolygon` (a `Polygon` would be wrapped). Every ring,
   outer and inner (holes), is kept in its original order.
3. Copy coordinates verbatim as `[lon, lat]` (WGS84): no simplification, reprojection, rounding
   or re-orientation. Each ring is checked to be closed and in range. (The script confirms the
   coordinate arrays are JSON-identical to the raw file's.)
4. Replace the ~150 source attributes with minimal properties: `name`, `source`,
   `source_objectid`, `unique_fire_id`.
5. Write compact JSON with a fixed key order and a trailing newline.

## Geometry

| | |
|---|---|
| Type | One `Feature`, `MultiPolygon` |
| Polygons | 16 |
| Rings | 16 (16 outer, **0 holes** — the source has no unburned islands mapped as inner rings) |
| Vertices | 10,501 (per polygon: 13, 8, 7, 13, 24, 7, 14, 21, 46, 5, 13, 7, 28, 9,743, 91, 461) |
| Bounding box | lon −118.685872 … −118.500566, lat 34.029849 … 34.129359 |

Hole handling is still implemented and unit-tested on synthetic geometry (§8.2), so a future
dataset with inner rings evaluates correctly.

## Demo properties (§8.3)

Chosen by `pnpm tsx scripts/find-properties.ts --write`, which writes `data/properties.json`.
Coordinates are points on a 0.001° grid (about 100 m), searched in integer micro-degrees, so
they are approximate locations, not street addresses. Labels are fictional. No damage-inspection
(DINS) record was used. Every value below is the script's output, re-evaluated with
`evaluate()` on the exact `lat_e6`/`lon_e6` integers to be registered. Trigger distance 500 m.

| ID | Label | lat_e6 | lon_e6 | ≈ lat, lon | inside | distance_m | Expected |
|---|---|---|---|---|---|---|---|
| 1 | Palisades · Home #1042 | 34045000 | -118526000 | 34.045, −118.526 | true | 672 | YES |
| 2 | Westside · Home #2210 | 34057000 | -118458000 | 34.057, −118.458 | false | 4000 | NO |
| 3 | Palisades · Home #1187 | 34055000 | -118515000 | 34.055, −118.515 | true | 559 | YES |

`distance_m` is the floored geodesic distance to the nearest ring; for 1 and 3 it is the margin
inside the perimeter edge, for 2 the distance outside it. Property 1 ↔ 3 separation: 1,504 m.

Selection rules (deterministic, ties broken by `lat_e6`, then `lon_e6`):

- **1 (YES):** grid points in the Pacific Palisades search window (lat 34.030–34.080,
  lon −118.570 to −118.500) that are inside the footprint with ≥ 300 m to every ring; pick the one
  nearest the search anchor (34.045, −118.526), which is the placeholder point printed in spec
  §8.4. The anchor itself qualified (672 m margin), so property 1 sits on it.
- **3 (YES):** same rule, and ≥ 1.5 km from property 1.
- **2 (NO):** grid points in a Brentwood / west Los Angeles window (lat 34.030–34.080,
  lon −118.480 to −118.440, inland of the Santa Monica Bay coastline) that are outside the
  footprint at 3–6 km from every ring (spec minimum 2 km); pick the one whose distance is nearest
  4 km.

Before registering these on Devnet, a human should check all three points on a real map
(build-plan §4 B acceptance): 1 and 3 should be in Pacific Palisades and 2 on land in Brentwood.
