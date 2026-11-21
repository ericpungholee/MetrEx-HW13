// Multi-peril market catalog (docs/spec-multiperil.md §3, §6, §7). Policy and display data, not
// frozen. Pure: no I/O. Shared by the app (cards, required text), the bot worker (per-market
// ladders) and the prepare script (which rounds and markets to open).
//
// Every number here is a starting quote for MetrEx-operated market makers, never a premium, an
// actuarial estimate or a forecast. The order book sets the executable price.
//
// Addresses are real OpenStreetMap address points chosen by scripts/find-real-properties.ts
// (data/market-properties.json). No damage data chose them, and no market says anything about
// damage to a home: each pays on hazard proximity or intensity only.

import type { BotParams } from "./ladder";
import {
  SCENARIO_HURRICANES_2017_09,
  SCENARIO_IOWA_TORNADOES_2024_05,
  SCENARIO_PALISADES_2025,
  SCENARIO_SOUTH_NAPA_2014_08,
} from "./constants";

export type Hazard = "wildfire" | "hurricane" | "earthquake" | "tornado";

export interface CatalogMarket {
  propertyId: number;
  scenarioId: number;
  hazard: Hazard;
  /** Real street address (an OpenStreetMap residential address point), as registered on-chain. */
  address: string;
  /** Region line above the title. */
  place: string;
  /** Forward-looking question. The disclosure below says it is a historical replay. */
  question: string;
  /** Short trigger line under the title. */
  trigger: string;
  /** Contract month as shown, e.g. "January 2025". */
  month: string;
  /** Required plain-text payout rule (§7.1), shown on every market page. */
  payoutRule: string;
  /** Which real event the replay uses. Shown next to the historical-replay disclosure. */
  replayOf: string;
  /** Settlement source, plain text. */
  source: string;
  /** Round label written on-chain (≤ 32 UTF-8 bytes). */
  roundLabel: string;
  /** Illustrative photo under app/public/markets (§7.3). */
  photo: { src: string; alt: string; credit: string; creditUrl: string };
  /** Starting bot quotes for this market (§6). */
  ladder: readonly BotParams[];
  /** Pairs a bot splits when its share inventory runs below one top size. */
  splitPairs: bigint;
}

const ladder = (
  a: [ref: number, half: number],
  b: [ref: number, half: number],
  c: [ref: number, half: number],
  sizes: [bigint, bigint, bigint] = [60_000n, 40_000n, 30_000n],
): BotParams[] => [
  { name: "A", refBps: a[0], halfSpreadBps: a[1], topSize: sizes[0], toleranceShares: sizes[0] * 10n, skewMaxBps: 0 },
  { name: "B", refBps: b[0], halfSpreadBps: b[1], topSize: sizes[1], toleranceShares: sizes[1] * 10n, skewMaxBps: 0 },
  { name: "C", refBps: c[0], halfSpreadBps: c[1], topSize: sizes[2], toleranceShares: sizes[2] * 10n, skewMaxBps: 0 },
];

export const CATALOG: readonly CatalogMarket[] = [
  {
    propertyId: 7,
    scenarioId: SCENARIO_PALISADES_2025,
    hazard: "wildfire",
    address: "16185 Sunset Boulevard",
    place: "Pacific Palisades, California",
    question: "Will 16185 Sunset Boulevard be affected by a wildfire this January?",
    trigger: "Wildfire within 500 metres",
    month: "January 2025",
    payoutRule:
      "Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage.",
    replayOf: "the Palisades Fire, January 2025",
    source: "NIFC WFIGS Interagency Perimeters (final mapped perimeter)",
    roundLabel: "Wildfire · Jan 2025 replay",
    photo: {
      src: "/markets/wildfire.webp",
      alt: "Aerial view of the Pacific Palisades coastline and hills",
      credit: "Alfred Twu · CC0 1.0",
      creditUrl: "https://commons.wikimedia.org/wiki/File:Pacific-Palisades-getty-villa-Aerial-from-west-August-2014.jpg",
    },
    // YES bids 74 / 80 / 82, asks 86 / 100 / 118 (0.74¢ … 1.18¢).
    ladder: ladder([80, 6], [90, 10], [100, 18]),
    splitPairs: 60_000n,
  },
  {
    propertyId: 4,
    scenarioId: SCENARIO_HURRICANES_2017_09,
    hazard: "hurricane",
    address: "1111 Memorial Drive",
    place: "Coral Gables, Florida",
    question: "Will 1111 Memorial Drive experience hurricane-force winds this September?",
    trigger: "Inside a 64-knot (74 mph) sustained wind swath",
    month: "September 2017",
    payoutRule:
      "Pays the full amount if this property lies inside the National Hurricane Center best-track 64-knot (hurricane-force) wind swath of any Atlantic hurricane during the coverage month. Pays on wind exposure, not on damage.",
    replayOf: "the September 2017 Atlantic hurricane season (Irma, Jose, Katia, Lee and Maria)",
    source: "NOAA National Hurricane Center best-track GIS wind swaths",
    roundLabel: "Hurricane · Sep 2017 replay",
    photo: {
      src: "/markets/hurricane.webp",
      alt: "Sunrise over Biscayne Bay from Matheson Hammock Park in Coral Gables",
      credit: "Anish Patel · CC BY-SA 4.0",
      creditUrl: "https://commons.wikimedia.org/wiki/File:Matheson_Hammock_Clouds.jpg",
    },
    // YES bids 111 / 120 / 123, asks 129 / 150 / 177.
    ladder: ladder([120, 9], [135, 15], [150, 27]),
    splitPairs: 60_000n,
  },
  {
    propertyId: 5,
    scenarioId: SCENARIO_SOUTH_NAPA_2014_08,
    hazard: "earthquake",
    address: "909 Stanly Way",
    place: "Napa, California",
    question: "Will 909 Stanly Way experience severe earthquake shaking this August?",
    trigger: "Modified Mercalli Intensity VIII or higher",
    month: "August 2014",
    payoutRule:
      "Pays the full amount if the USGS ShakeMap intensity at the grid point nearest this property reached Modified Mercalli VIII or higher during the coverage month. Pays on measured shaking, not on damage.",
    replayOf: "the M6.0 South Napa earthquake, August 2014",
    source: "USGS ShakeMap (event nc72282711)",
    roundLabel: "Earthquake · Aug 2014 replay",
    photo: {
      src: "/markets/earthquake.webp",
      alt: "Vineyards and hills in Napa Valley",
      credit: "Brocken Inaglory · CC BY-SA 3.0",
      creditUrl: "https://commons.wikimedia.org/wiki/File:Vineyards_in_Napa_Valley.jpg",
    },
    // YES bids 9 / 8 / 7, asks 11 / 12 / 15 (0.09¢ … 0.15¢).
    ladder: ladder([10, 1], [10, 2], [11, 4]),
    splitPairs: 60_000n,
  },
  {
    propertyId: 6,
    scenarioId: SCENARIO_IOWA_TORNADOES_2024_05,
    hazard: "tornado",
    address: "7007 Peckham Street",
    place: "Johnston, Iowa",
    question: "Will 7007 Peckham Street be affected by a tornado this May?",
    trigger: "EF2+ tornado within 500 metres",
    month: "May 2024",
    payoutRule:
      "Pays the full amount if the surveyed centerline of an EF2-or-stronger tornado passed within 500 m of this property during the coverage month. Pays on tornado proximity, not on damage.",
    replayOf: "the central Iowa tornado outbreak, May 2024 (EF2+ tracks of 21 May)",
    source: "NOAA NWS Damage Assessment Toolkit surveyed tracks",
    roundLabel: "Tornado · May 2024 replay",
    photo: {
      src: "/markets/tornado.webp",
      alt: "Aerial view of Saylorville Lake and Dam near Johnston, Iowa",
      credit: "U.S. Army Corps of Engineers · Public domain",
      creditUrl: "https://commons.wikimedia.org/wiki/File:USACE_Saylorville_Lake_and_Dam.jpg",
    },
    // YES bids 28 / 30 / 31, asks 32 / 38 / 45.
    ladder: ladder([30, 2], [34, 4], [38, 7]),
    splitPairs: 60_000n,
  },
];

export const catalogByProperty = (propertyId: number): CatalogMarket | undefined =>
  CATALOG.find((c) => c.propertyId === propertyId);

/** The catalog entry for a scenario (one featured market per hazard). */
export const catalogByScenario = (scenarioId: number): CatalogMarket | undefined =>
  CATALOG.find((c) => c.scenarioId === scenarioId);

/** Bot parameters for one market: its own entry, else its scenario's, else `fallback`. */
export function ladderFor(propertyId: number, scenarioId: number, botName: string, fallback: BotParams): BotParams {
  const entry = catalogByProperty(propertyId) ?? catalogByScenario(scenarioId);
  return entry?.ladder.find((b) => b.name === botName) ?? fallback;
}

export const HAZARD_LABEL: Record<Hazard, string> = {
  wildfire: "Wildfire",
  hurricane: "Hurricane",
  earthquake: "Earthquake",
  tornado: "Tornado",
};
