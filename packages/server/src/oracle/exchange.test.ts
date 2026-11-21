// v2 oracle (spec-v2 §9.3, §13.2 Oracle): round gate, dataset hash refusal, evidence v2 canonical bytes.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@metrex/geo";
import type { ConfigView, MarketView, RoundView } from "../exchange/accounts";
import { assertDatasetHash, assertRoundGate, buildExchangeEvidence, exchangeSettlementMatches, getExchangeSettledOverlay, resolutionDeadline } from "./exchange";
import { dataDir } from "../env";
import { writeEvidence } from "./evidence-store";

const k = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));
const DATA = dataDir();
const datasetHash = Uint8Array.from(createHash("sha256").update(readFileSync(join(DATA, "palisades-2025.geojson"))).digest());

const round = (o: Partial<RoundView> = {}): RoundView => ({
  address: k(1),
  roundId: 4n,
  scenarioId: 1,
  datasetSha256: datasetHash,
  label: "Palisades replay #4",
  status: "closed",
  createdAt: 100n,
  tradingEndsAt: 1_000n,
  closedAt: 500n,
  marketCount: 2,
  resolvedCount: 0,
  ...o,
});
const config: ConfigView = {
  address: k(2), admin: k(3), roundController: k(4), oracleAuthority: k(5), collateralMint: k(6), latestRound: k(1),
  nextRoundId: 5n, resolutionTimeoutS: 86_400n,
};
// Coordinates of registered property 1 (data/DATASET.md).
const market = (o: Partial<MarketView> = {}): MarketView => ({
  address: k(9), round: k(1), propertyId: 1, scenarioId: 1, latE6: 34_045_000, lonE6: -118_526_000, triggerDistanceM: 500,
  yesMint: k(10), noMint: k(11), vault: k(12), outcome: "unresolved", evidenceHash: new Uint8Array(32), pairsOutstanding: 0n,
  nextOrderSeq: 0n, createdAt: 0n, resolvedAt: 0n, resolutionPath: 0, invalidReason: 0, ...o,
});
const PID = new PublicKey("BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko");

describe("round gate (§9.3 step 1)", () => {
  it("resolves only a Closed round's Unresolved market while now < T", () => {
    const T = resolutionDeadline(round(), config);
    expect(T).toBe(86_900n);
    expect(assertRoundGate(round(), market(), config, T - 1n)).toBe("resolve");
    expect(() => assertRoundGate(round(), market(), config, T)).toThrow(/window has closed/);
    expect(() => assertRoundGate(round({ status: "open", closedAt: 0n }), market(), config, 600n)).toThrow(/still Open/);
    expect(() => assertRoundGate(round(), market({ round: k(99) }), config, 600n)).toThrow(/does not belong/);
  });
  it("idempotent: a resolved market is verified, never resolved again; Invalid is refused", () => {
    expect(assertRoundGate(round(), market({ outcome: "yes" }), config, 999_999n)).toBe("already_resolved");
    expect(() => assertRoundGate(round(), market({ outcome: "invalid" }), config, 600n)).toThrow(/Invalid/);
  });
});

describe("dataset hash (§9.3 step 2)", () => {
  it("accepts the committed file and refuses any other bytes", () => {
    const bytes = readFileSync(join(DATA, "palisades-2025.geojson"));
    expect(assertDatasetHash(bytes, round())).toBe(Buffer.from(datasetHash).toString("hex"));
    const tampered = Buffer.concat([bytes, Buffer.from(" ")]);
    expect(() => assertDatasetHash(tampered, round())).toThrow(/Dataset hash mismatch/);
    expect(() => buildExchangeEvidence(market(), round({ datasetSha256: new Uint8Array(32).fill(1) }), PID, DATA)).toThrow(/mismatch/);
  });
});

describe("evidence v2 (§9.3 steps 3–4)", () => {
  it("is canonical, carries the round and version 2, and is built from on-chain coordinates", () => {
    const built = buildExchangeEvidence(market(), round(), PID, DATA);
    expect(built.record.version).toBe(2);
    expect(built.record.round).toBe(k(1).toBase58());
    expect(built.record.program_id).toBe(PID.toBase58());
    expect(built.record.property).toEqual({ id: 1, lat_e6: 34_045_000, lon_e6: -118_526_000 });
    expect(canonicalize(built.record)).toBe(built.canonical);
    expect(createHash("sha256").update(built.canonical).digest("hex")).toBe(built.hashHex);
    // The settlement check needs both the outcome and the hash to match.
    const hash = Uint8Array.from(built.hashBytes);
    const outcome = built.record.triggered ? "yes" : "no";
    expect(exchangeSettlementMatches(market({ outcome, evidenceHash: hash }), built.record.triggered, built.hashHex)).toBe(true);
    expect(exchangeSettlementMatches(market({ outcome, evidenceHash: new Uint8Array(32) }), built.record.triggered, built.hashHex)).toBe(false);
  });
});

describe("historical risk overlays (spec-multiperil §5)", () => {
  const properties: {
    property_id: number; scenario_id: number; lat_e6: number; lon_e6: number; trigger_distance_m: number;
  }[] = JSON.parse(readFileSync(join(DATA, "market-properties.json"), "utf8"));
  const cases = [
    { propertyId: 7, kind: "wildfire", file: "palisades-2025.geojson" },
    { propertyId: 4, kind: "hurricane", file: "atlantic-hurricanes-2017-09.geojson" },
    { propertyId: 5, kind: "earthquake", file: "south-napa-2014-08.json" },
    { propertyId: 6, kind: "tornado", file: "central-iowa-tornadoes-2024-05.geojson" },
  ] as const;

  it.each(cases)("publishes the $kind layer only with matching finalized evidence", async ({ propertyId, kind, file }) => {
    const property = properties.find((p) => p.property_id === propertyId);
    if (!property) throw new Error(`Missing catalog property ${propertyId}`);
    const m = market({
      scenarioId: property.scenario_id,
      propertyId: property.property_id,
      latE6: property.lat_e6,
      lonE6: property.lon_e6,
      triggerDistanceM: property.trigger_distance_m,
    });
    const sha = createHash("sha256").update(readFileSync(join(DATA, file))).digest();
    const r = round({ scenarioId: m.scenarioId, datasetSha256: sha });
    const built = buildExchangeEvidence(m, r, PID, DATA);
    const dir = mkdtempSync(join(tmpdir(), "metrex-overlay-"));
    try {
      symlinkSync(join(DATA, "scenarios.json"), join(dir, "scenarios.json"));
      symlinkSync(join(DATA, file), join(dir, file));
      await writeEvidence(dir, m.address, built.canonical);
      const read = (state: MarketView) => getExchangeSettledOverlay(m.address, {
        dataDir: dir,
        readFinalizedMarket: async () => state,
      });
      await expect(read({ ...m, evidenceHash: built.hashBytes })).rejects.toMatchObject({ status: 404 });
      await expect(read({ ...m, outcome: "invalid", evidenceHash: built.hashBytes })).rejects.toMatchObject({ status: 404 });
      const outcome = built.record.triggered ? "yes" : "no";
      await expect(read({ ...m, outcome })).rejects.toMatchObject({ status: 503 });
      const finalized: MarketView = { ...m, outcome, evidenceHash: built.hashBytes };
      const result = await read(finalized);
      expect(result.evidenceHash).toBe(built.hashHex);
      expect(result.overlay.kind).toBe(kind);
      if (result.overlay.kind === "earthquake") {
        expect(result.overlay.nearest).toEqual(built.record.version === 3 && built.record.computed);
        expect(result.overlay.nodes).toContainEqual([
          result.overlay.nearest.node_lon_e4, result.overlay.nearest.node_lat_e4, result.overlay.nearest.mmi_x10,
        ]);
      } else if (result.overlay.kind === "wildfire") {
        expect(result.overlay.geometry.coordinates.length).toBeGreaterThan(0);
      } else {
        expect(result.overlay.geometry.features.length).toBeGreaterThan(0);
        expect(result.overlay.geometry.features[0]?.geometry.type).toBe(kind === "tornado" ? "MultiLineString" : "MultiPolygon");
      }
      rmSync(join(dir, file));
      await expect(read(finalized)).rejects.toMatchObject({ status: 503 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
