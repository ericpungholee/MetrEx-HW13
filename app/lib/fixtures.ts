// FIXTURE DATA — used only when NEXT_PUBLIC_USE_FIXTURES=1 (dev only; `next build` refuses it).
// Every page shows a "FIXTURE DATA" banner in this mode and every write is disabled.
// Nothing here is on-chain. Coordinates are the placeholder point from spec §8.4
// (property 1) and labelled placeholder offsets from it; they are NOT registered
// properties and must never be used as demo coordinates.
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import {
  encodeLabel,
  findListingPda,
  findMarketPda,
  findOfferPda,
  findPropertyPda,
  computeOfferTerms,
  MUSD_UNIT,
  SCENARIO_PALISADES_2025,
  Side,
  type ConfigAccount,
  type EvidenceRecord,
  type ListingAccount,
  type MarketAccount,
  type MarketStatus,
  type OfferAccount,
  type OfferStatus,
  type PropertyAccount,
} from "@metrex/shared";
import type { Keyed } from "./types";

function fixtureKey(i: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7 + 1) % 256));
}

const DEFAULT_KEY = PublicKey.default;

export const FIXTURE_KEYS = {
  admin: fixtureKey(1),
  oracle: fixtureKey(2),
  controller: fixtureKey(3),
  mint: fixtureKey(4),
  homeowner: fixtureKey(10),
  homeowner2: fixtureKey(11),
  botA: fixtureKey(20),
  botB: fixtureKey(21),
  botC: fixtureKey(22),
  judge: fixtureKey(30),
} as const;

/** Wallet the fixture pages "view as" when no wallet is connected. */
export const FIXTURE_VIEWER = FIXTURE_KEYS.homeowner;

const NOW = 1_768_000_000; // fixed fixture clock (unix seconds)
const mUSD = (n: number) => new BN(n).mul(new BN(MUSD_UNIT.toString()));

function statusRaw<T extends string>(s: T): { [K in T]: Record<string, never> } {
  return { [s]: {} } as { [K in T]: Record<string, never> };
}

// Spec §8.4 placeholder point, plus labelled offsets for the other two fixtures.
const PLACEHOLDER = { lat: 34_045_000, lon: -118_526_000 };
const FIXTURE_PROPERTIES: { id: number; label: string; lat: number; lon: number }[] = [
  { id: 1, label: "Palisades · Home #1042", lat: PLACEHOLDER.lat, lon: PLACEHOLDER.lon },
  { id: 2, label: "Westside · Home #2210", lat: PLACEHOLDER.lat - 30_000, lon: PLACEHOLDER.lon + 60_000 },
  { id: 3, label: "Palisades · Home #1187", lat: PLACEHOLDER.lat + 6_000, lon: PLACEHOLDER.lon - 8_000 },
];

export interface FixtureState {
  config: ConfigAccount;
  properties: Keyed<PropertyAccount>[];
  markets: Keyed<MarketAccount>[];
  offers: Keyed<OfferAccount>[];
  listings: Keyed<ListingAccount>[];
  balances: Map<string, bigint>;
  evidence: Map<string, string>;
}

let statePromise: Promise<FixtureState> | null = null;

export function getFixtureState(programId: PublicKey): Promise<FixtureState> {
  statePromise ??= build(programId);
  return statePromise;
}

async function sha256(bytes: Uint8Array): Promise<number[]> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest));
}

async function build(programId: PublicKey): Promise<FixtureState> {
  const config: ConfigAccount = {
    admin: FIXTURE_KEYS.admin,
    oracleAuthority: FIXTURE_KEYS.oracle,
    demoController: FIXTURE_KEYS.controller,
    mint: FIXTURE_KEYS.mint,
    bump: 255,
  };

  const properties: Keyed<PropertyAccount>[] = FIXTURE_PROPERTIES.map((p) => ({
    publicKey: findPropertyPda(programId, p.id)[0],
    account: {
      propertyId: p.id,
      label: encodeLabel(p.label),
      latE6: p.lat,
      lonE6: p.lon,
      scenarioId: SCENARIO_PALISADES_2025,
      triggerDistanceM: 500,
      bump: 255,
    },
  }));

  const markets: Keyed<MarketAccount>[] = [];
  const offers: Keyed<OfferAccount>[] = [];
  const listings: Keyed<ListingAccount>[] = [];
  const evidence = new Map<string, string>();

  function addMarket(
    nonce: number,
    homeowner: PublicKey,
    propertyIdx: number,
    target: number,
    status: MarketStatus,
    ageMin: number,
  ): Keyed<MarketAccount> {
    const p = FIXTURE_PROPERTIES[propertyIdx]!;
    const publicKey = findMarketPda(programId, homeowner, nonce)[0];
    const m: Keyed<MarketAccount> = {
      publicKey,
      account: {
        homeowner,
        marketNonce: new BN(nonce),
        propertyId: p.id,
        latE6: p.lat,
        lonE6: p.lon,
        scenarioId: SCENARIO_PALISADES_2025,
        triggerDistanceM: 500,
        coverageTarget: mUSD(target),
        coverageActivated: new BN(0),
        acceptedCount: 0,
        status: statusRaw(status) as MarketAccount["status"],
        evidenceHash: new Array(32).fill(0),
        createdAt: new BN(NOW - ageMin * 60),
        closedAt: new BN(status === "open" ? 0 : NOW - 120),
        resolvedAt: new BN(status === "resolvedYes" || status === "resolvedNo" ? NOW - 60 : 0),
        bump: 255,
      },
    };
    markets.push(m);
    return m;
  }

  let nonce = 100;
  function addOffer(
    market: Keyed<MarketAccount>,
    underwriter: PublicKey,
    coverage: number,
    bps: number,
    status: OfferStatus,
    holders?: { protection?: PublicKey; risk?: PublicKey },
  ): Keyed<OfferAccount> {
    nonce += 1;
    const terms = computeOfferTerms(BigInt(coverage) * MUSD_UNIT, bps);
    const accepted = status === "accepted" || status === "claimed" || status === "refunded";
    const o: Keyed<OfferAccount> = {
      publicKey: findOfferPda(programId, market.publicKey, underwriter, nonce)[0],
      account: {
        market: market.publicKey,
        underwriter,
        offerNonce: new BN(nonce),
        coverage: new BN(terms.coverage.toString()),
        premiumBps: bps,
        premium: new BN(terms.premium.toString()),
        collateral: new BN(terms.collateral.toString()),
        protectionHolder: accepted ? (holders?.protection ?? market.account.homeowner) : DEFAULT_KEY,
        riskHolder: accepted ? (holders?.risk ?? underwriter) : DEFAULT_KEY,
        status: statusRaw(status) as OfferAccount["status"],
        createdAt: new BN(NOW - 600 + nonce),
        acceptedAt: new BN(accepted ? NOW - 300 : 0),
        bump: 255,
        vaultBump: 254,
      },
    };
    if (accepted) {
      market.account.coverageActivated = market.account.coverageActivated.add(o.account.coverage);
      market.account.acceptedCount += 1;
    }
    offers.push(o);
    return o;
  }

  const k = FIXTURE_KEYS;

  // A: Accepting offers — 6,000 of 10,000 funded, three open offers (spec §3.3 card).
  const a = addMarket(1, k.homeowner, 0, 10_000, "open", 12);
  addOffer(a, k.botA, 4_000, 400, "accepted");
  const aRisk = addOffer(a, k.botB, 2_000, 450, "accepted");
  addOffer(a, k.botC, 3_000, 420, "open");
  addOffer(a, k.botA, 2_000, 480, "open");
  addOffer(a, k.judge, 1_000, 390, "open");
  addOffer(a, k.botB, 500, 400, "cancelled");
  listings.push({
    publicKey: findListingPda(programId, aRisk.publicKey, Side.Risk)[0],
    account: {
      offer: aRisk.publicKey,
      side: Side.Risk,
      seller: k.botB,
      price: mUSD(70),
      createdAt: new BN(NOW - 90),
      bump: 255,
    },
  });

  // B: Funded — Home #1187, fully activated.
  const b = addMarket(2, k.homeowner2, 2, 5_000, "open", 30);
  addOffer(b, k.botA, 3_000, 410, "accepted");
  addOffer(b, k.botC, 2_000, 500, "accepted", { risk: k.homeowner });
  addOffer(b, k.botB, 1_000, 520, "open");

  // C: Closed — awaiting oracle.
  const c = addMarket(3, k.homeowner2, 0, 8_000, "closed", 45);
  addOffer(c, k.botA, 4_000, 400, "accepted");
  addOffer(c, k.botB, 4_000, 450, "accepted");

  // D: Resolved YES — homeowner can claim.
  const d = addMarket(4, k.homeowner, 0, 10_000, "resolvedYes", 90);
  addOffer(d, k.botA, 4_000, 400, "accepted");
  addOffer(d, k.botB, 3_000, 450, "accepted");
  addOffer(d, k.botC, 3_000, 500, "claimed");

  // E: Resolved NO — Westside home, underwriters claim.
  const e = addMarket(5, k.homeowner2, 1, 6_000, "resolvedNo", 120);
  addOffer(e, k.botA, 3_000, 300, "accepted", { risk: k.homeowner });
  addOffer(e, k.botB, 3_000, 350, "claimed");

  // Evidence records for the resolved fixtures (real SHA-256 of the fixture bytes).
  for (const m of [d, e]) {
    const triggered = m === d;
    const rec: EvidenceRecord = {
      computed: { distance_m: triggered ? 0 : 2_400, inside: triggered },
      dataset: {
        name: "palisades-2025",
        retrieved: "FIXTURE",
        sha256: "0".repeat(64),
        source: "FIXTURE — not a real dataset",
      },
      market: m.publicKey.toBase58(),
      program_id: programId.toBase58(),
      property: { id: m.account.propertyId, lat_e6: m.account.latE6, lon_e6: m.account.lonE6 },
      scenario_id: m.account.scenarioId,
      trigger_distance_m: m.account.triggerDistanceM,
      triggered,
      version: 1,
    };
    const json = canonicalFixtureJson(rec);
    evidence.set(m.publicKey.toBase58(), json);
    m.account.evidenceHash = await sha256(new TextEncoder().encode(json));
  }

  const balances = new Map<string, bigint>([
    [k.homeowner.toBase58(), 2_500n * MUSD_UNIT],
    [k.homeowner2.toBase58(), 900n * MUSD_UNIT],
    [k.judge.toBase58(), 25_000n * MUSD_UNIT],
  ]);

  return { config, properties, markets, offers, listings, balances, evidence };
}

/** Sorted-key, whitespace-free JSON for the fixture evidence only (geo owns the real one). */
function canonicalFixtureJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalFixtureJson(obj[key])}`)
    .join(",")}}`;
}
