// §8.4 canonical JSON, hashing and evidence.
import type { Polygon } from "geojson";
import type { ScenarioEntry } from "@metrex/shared";
import { describe, expect, it } from "vitest";
import {
  buildEvidence,
  canonicalBytes,
  canonicalize,
  hexToBytes32,
  sha256Hex,
  verifyEvidenceText,
} from "../src";

const enc = (s: string) => new TextEncoder().encode(s);

describe("canonicalize §8.4", () => {
  it("sorts keys at every level, no whitespace", () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("is independent of insertion order", () => {
    expect(canonicalize({ x: 1, y: { q: true, p: null } })).toBe(canonicalize({ y: { p: null, q: true }, x: 1 }));
  });

  it("encodes primitives and escapes strings like JSON", () => {
    expect(canonicalize([true, false, null, -5, 0, 'a"b\\c', "·"])).toBe('[true,false,null,-5,0,"a\\"b\\\\c","·"]');
    expect(canonicalBytes({ s: "·" })).toEqual(enc('{"s":"·"}'));
  });

  it("rejects non-integers and non-JSON values", () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow(/integer/);
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalize({ a: 2 ** 53 })).toThrow();
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize({ a: 1n })).toThrow();
    expect(() => canonicalize({ a: new Date(0) })).toThrow();
  });

  it("treats -0 as 0", () => {
    expect(canonicalize({ a: -0 })).toBe('{"a":0}');
  });
});

describe("sha256Hex", () => {
  // Known answers verified independently with `printf '<s>' | shasum -a 256`.
  it("matches shasum -a 256 for 'abc'", () => {
    expect(sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("matches shasum -a 256 for a canonical object", () => {
    const c = canonicalize({ b: [true, null, "x"], a: 1 });
    expect(c).toBe('{"a":1,"b":[true,null,"x"]}');
    expect(sha256Hex(enc(c))).toBe("eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1");
  });
  it("hexToBytes32 round-trips", () => {
    const h = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const b = hexToBytes32(h);
    expect(b.length).toBe(32);
    expect(Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")).toBe(h);
    expect(() => hexToBytes32("zz")).toThrow();
  });
});

describe("buildEvidence §8.4", () => {
  const geometry: Polygon = {
    type: "Polygon",
    coordinates: [[[-118.53, 34.04], [-118.52, 34.04], [-118.52, 34.05], [-118.53, 34.05], [-118.53, 34.04]]],
  };
  const scenario: ScenarioEntry = {
    scenarioId: 1,
    name: "palisades-2025",
    title: "Palisades Fire, January 2025",
    file: "palisades-2025.geojson",
    sha256: "00".repeat(32),
    source: "https://example.invalid/source",
    retrieved: "2026-11-20",
  };
  const input = {
    market: "11111111111111111111111111111111",
    programId: "BPFLoaderUpgradeab1e11111111111111111111111",
    property: { id: 1, lat_e6: 34_045_000, lon_e6: -118_525_000 },
    scenarioId: 1,
    triggerDistanceM: 500,
    scenario,
    geometry,
  };

  it("produces the §8.4 field set in canonical order", () => {
    const ev = buildEvidence(input);
    expect(ev.canonical).toMatch(
      /^\{"computed":\{"distance_m":\d+,"inside":true\},"dataset":\{"name":"palisades-2025","retrieved":"2026-11-20","sha256":"0{64}","source":"https:\/\/example\.invalid\/source"\},"market":"1{32}","program_id":"BPFLoaderUpgradeab1e1{23}","property":\{"id":1,"lat_e6":34045000,"lon_e6":-118525000\},"scenario_id":1,"trigger_distance_m":500,"triggered":true,"version":1\}$/,
    );
    expect(ev.record.version).toBe(1);
    expect(ev.hashBytes.length).toBe(32);
    expect(ev.hashHex).toBe(sha256Hex(enc(ev.canonical)));
  });

  it("is byte-identical across runs", () => {
    const a = buildEvidence(input);
    const b = buildEvidence({ ...input, property: { lon_e6: -118_525_000, lat_e6: 34_045_000, id: 1 } });
    expect(a.canonical).toBe(b.canonical);
    expect(a.hashHex).toBe(b.hashHex);
    expect(a.hashBytes).toEqual(b.hashBytes);
  });

  it("verifyEvidenceText re-derives the same hash", () => {
    const ev = buildEvidence(input);
    expect(verifyEvidenceText(ev.canonical)).toEqual({ hashHex: ev.hashHex, isCanonical: true });
    const pretty = JSON.stringify(ev.record, null, 2);
    expect(verifyEvidenceText(pretty)).toEqual({ hashHex: ev.hashHex, isCanonical: false });
  });

  it("refuses a scenario entry that does not match scenarioId, and bad keys", () => {
    expect(() => buildEvidence({ ...input, scenarioId: 2 })).toThrow(/does not match/);
    expect(() => buildEvidence({ ...input, market: "not-base58!" })).toThrow();
  });
});
