// v2 oracle (spec-v2 §9.3, §13.2 Oracle): round gate, dataset hash refusal, evidence v2 canonical bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@metrex/geo";
import type { ConfigView, MarketView, RoundView } from "../exchange/accounts";
import { assertDatasetHash, assertRoundGate, buildExchangeEvidence, exchangeSettlementMatches, resolutionDeadline } from "./exchange";
import { dataDir } from "../env";

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
