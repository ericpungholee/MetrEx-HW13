import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadScenarioRegistry } from "@metrex/geo/node";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
import { describe, expect, it, vi } from "vitest";
import { errorCode, findMarketPda, MUSD_UNIT, type ScenarioRegistry } from "@metrex/shared";
import { MARKET_STATUS_INDEX, OFFER_STATUS_INDEX, OFFSETS, fetchMarket, filters, type MarketView } from "./accounts";
import { dataDir, expandHome, loadKeypairFile, parsePublicKey, repoRoot } from "./env";
import { explorerAddress, explorerTx } from "./explorer";
import { programDataAddress } from "./ix";
import { getProgram, loadIdl } from "./program";
import { getEvidence } from "./oracle/evidence";
import { readEvidenceBytes, sha256Hex, writeEvidence } from "./oracle/evidence-store";
import { realGeo, type GeoAdapter } from "./oracle/geo-adapter";
import { assertResolvable, buildMarketEvidence, resolveMarket } from "./oracle/resolve";
import { HttpError } from "./routes/errors";
import { FAUCET_MUSD, FAUCET_SOL_LAMPORTS, FaucetLimiter, faucetInstructions } from "./routes/faucet";
import { handleFaucet } from "./routes/http";
import { handleClose, handleEvidence, handleResolve } from "./routes/legacy-http";
import { checkDemoPassword, OperatorPasswordBudget } from "./routes/password";
import { formatMusd, formatSol, formatUnits, musd, solToLamports } from "./token";
import { RpcPool } from "./rpc";
import { describeErrorText } from "./tx";

// ---------- IDL layout ----------

type IdlField = { name: string; type: unknown };
const SIZES: Record<string, number> = { pubkey: 32, u64: 8, i64: 8, u32: 4, i32: 4, u16: 2, u8: 1, bool: 1 };
function sizeOf(t: unknown): number {
  if (typeof t === "string") {
    const s = SIZES[t];
    if (s === undefined) throw new Error(`size of ${t}`);
    return s;
  }
  const o = t as { array?: [unknown, number]; defined?: { name: string } };
  if (o.array) return sizeOf(o.array[0]) * o.array[1];
  if (o.defined) return 1; // fieldless enums
  throw new Error(`size of ${JSON.stringify(t)}`);
}
function offsetsOf(account: string): Record<string, number> {
  const idl = loadIdl() as unknown as { types: { name: string; type: { fields: IdlField[] } }[] };
  const t = idl.types.find((x) => x.name === account);
  if (!t) throw new Error(account);
  const out: Record<string, number> = {};
  let off = 8;
  for (const f of t.type.fields) {
    out[f.name] = off;
    off += sizeOf(f.type);
  }
  return out;
}

describe("account layout (frozen IDL)", () => {
  it("memcmp offsets match the IDL field order", () => {
    const m = offsetsOf("Market");
    expect(OFFSETS.market).toEqual({
      homeowner: m.homeowner,
      marketNonce: m.market_nonce,
      propertyId: m.property_id,
      status: m.status,
    });
    const o = offsetsOf("Offer");
    expect(OFFSETS.offer).toEqual({ market: o.market, underwriter: o.underwriter, riskHolder: o.risk_holder, status: o.status });
    const l = offsetsOf("Listing");
    expect(OFFSETS.listing).toEqual({ offer: l.offer, side: l.side, seller: l.seller });
  });

  it("reads a finalized Market only under the program owner at its canonical PDA", async () => {
    const rpc = new RpcPool(["http://127.0.0.1:8899"]);
    const program = getProgram(rpc.connection);
    const homeowner = Keypair.generate().publicKey;
    const [pk, bump] = findMarketPda(program.programId, homeowner, 12n);
    const data = await program.coder.accounts.encode("market", {
      homeowner, marketNonce: new BN(12), propertyId: 1, latE6: 0, lonE6: 0,
      scenarioId: 1, triggerDistanceM: 500, coverageTarget: new BN(10),
      coverageActivated: new BN(0), acceptedCount: 0, status: { closed: {} },
      evidenceHash: new Uint8Array(32), createdAt: new BN(1), closedAt: new BN(2),
      resolvedAt: new BN(0), bump,
    });
    const base = { data, lamports: 1, executable: false, rentEpoch: 0 };
    const rpcRead = vi.spyOn(rpc.connection, "getAccountInfo")
      .mockResolvedValueOnce({ ...base, owner: SystemProgram.programId })
      .mockResolvedValue({ ...base, owner: program.programId });
    expect(await fetchMarket(program, pk, "finalized")).toBeNull();
    expect(await fetchMarket(program, Keypair.generate().publicKey, "finalized")).toBeNull();
    expect((await fetchMarket(program, pk, "finalized"))?.status).toBe("closed");
    expect(rpcRead).toHaveBeenCalledWith(pk, "finalized");
  });

  it("status indices follow the IDL enum variant order", () => {
    const idl = loadIdl() as unknown as { types: { name: string; type: { variants?: { name: string }[] } }[] };
    const variants = (n: string) => idl.types.find((t) => t.name === n)?.type.variants?.map((v) => v.name) ?? [];
    expect(variants("MarketStatus")).toEqual(["Open", "Closed", "ResolvedYes", "ResolvedNo", "Voided"]);
    expect(Object.values(MARKET_STATUS_INDEX)).toEqual([0, 1, 2, 3, 4]);
    expect(variants("OfferStatus")).toEqual(["Open", "Accepted", "Cancelled", "Claimed", "Refunded"]);
    expect(Object.values(OFFER_STATUS_INDEX)).toEqual([0, 1, 2, 3, 4]);
  });

  it("builds memcmp filters with base58 bytes", () => {
    expect(filters.marketStatus("open")).toEqual({ memcmp: { offset: 82, bytes: "1" } });
    expect(filters.offerStatus("accepted")).toEqual({ memcmp: { offset: 170, bytes: "2" } });
    const pk = Keypair.generate().publicKey;
    expect(filters.offerUnderwriter(pk)).toEqual({ memcmp: { offset: 40, bytes: pk.toBase58() } });
  });

  it("derives ProgramData from the upgradeable loader", () => {
    const pid = new PublicKey(loadIdl().address);
    const pd = programDataAddress(pid);
    expect(pd.equals(pid)).toBe(false);
    expect(PublicKey.isOnCurve(pd.toBytes())).toBe(false);
  });
});

// ---------- env / format ----------

describe("env helpers", () => {
  it("expands ~ and finds the repo root", () => {
    expect(expandHome("~/x")).not.toContain("~");
    expect(readFileSync(join(repoRoot(), "pnpm-workspace.yaml"), "utf8")).toContain("packages");
  });

  it("validates public keys strictly", () => {
    const pk = Keypair.generate().publicKey.toBase58();
    expect(parsePublicKey(pk).toBase58()).toBe(pk);
    expect(() => parsePublicKey("../../etc/passwd")).toThrow("Invalid");
    expect(() => parsePublicKey("")).toThrow("Invalid");
    expect(() => parsePublicKey("0OIl".repeat(10))).toThrow("Invalid");
  });

  it("loads a keypair file and never echoes its content on error", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrex-kp-"));
    const kp = Keypair.generate();
    writeFileSync(join(dir, "ok.json"), JSON.stringify(Array.from(kp.secretKey)));
    expect(loadKeypairFile(join(dir, "ok.json")).publicKey.equals(kp.publicKey)).toBe(true);
    writeFileSync(join(dir, "bad.json"), JSON.stringify([1, 2, 3]));
    expect(() => loadKeypairFile(join(dir, "bad.json"))).toThrow("not a 64-byte JSON array");
  });

  it("formats amounts without floating point", () => {
    expect(formatUnits(10_000_000_000n, 6)).toBe("10000");
    expect(formatMusd(1_500_001n)).toBe("1.500001");
    expect(formatSol(5_000n)).toBe("0.000005");
    expect(solToLamports("0.05")).toBe(50_000_000n);
    expect(solToLamports("1")).toBe(1_000_000_000n);
    expect(musd(25_000n)).toBe(25_000n * MUSD_UNIT);
    expect(() => solToLamports("-1")).toThrow();
  });

  it("builds devnet explorer links", () => {
    expect(explorerTx("abc")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
    expect(explorerAddress("xyz")).toBe("https://explorer.solana.com/address/xyz?cluster=devnet");
  });

  it("maps program errors to readable messages", () => {
    const code = errorCode("SelfUnderwriting");
    expect(describeErrorText(`custom program error: 0x${code.toString(16)}`)).toMatch(/^SelfUnderwriting:/);
    expect(
      describeErrorText(`Program log: AnchorError ... Error Code: InvalidBps. Error Number: ${errorCode("InvalidBps")}.`),
    ).toMatch(/^InvalidBps:/);
    expect(describeErrorText("nothing here")).toBeUndefined();
  });
});

// ---------- password ----------

describe("checkDemoPassword", () => {
  it("denies when unset or empty", () => {
    expect(checkDemoPassword("x", undefined)).toBe(false);
    expect(checkDemoPassword("x", "")).toBe(false);
  });
  it("compares exactly", () => {
    expect(checkDemoPassword("hunter2", "hunter2")).toBe(true);
    expect(checkDemoPassword("hunter3", "hunter2")).toBe(false);
    expect(checkDemoPassword("hunter2 ", "hunter2")).toBe(false);
    expect(checkDemoPassword(null, "hunter2")).toBe(false);
    expect(checkDemoPassword("", "hunter2")).toBe(false);
  });
});

// ---------- faucet ----------

describe("faucet", () => {
  it("allows one request per wallet per window", () => {
    const l = new FaucetLimiter(10 * 60 * 1000, 100);
    l.reserve("w1", 0);
    expect(() => l.reserve("w1", 9 * 60 * 1000)).toThrow(HttpError);
    l.reserve("w1", 10 * 60 * 1000);
  });

  it("enforces the 100-wallet hard cap but lets known wallets return", () => {
    const l = new FaucetLimiter(1000, 100, 200);
    for (let i = 0; i < 100; i++) l.reserve(`w${i}`, 0);
    expect(() => l.reserve("new", 5000)).toThrow(/limit/);
    l.reserve("w0", 5000);
    expect(l.size).toBe(100);
  });

  it("shares the faucet request budget across different wallets", () => {
    const l = new FaucetLimiter(10 * 60_000, 100, 2);
    l.reserve("first", 0);
    l.reserve("second", 1);
    expect(() => l.reserve("third", 59_999)).toThrow(/request limit/);
    l.reserve("third", 60_000);
  });

  it("release restores the previous state", () => {
    const l = new FaucetLimiter();
    l.reserve("w", 100);
    l.release("w", undefined);
    expect(l.lastRequest("w")).toBeUndefined();
    l.reserve("w", 200);
  });

  it("sends 0.05 SOL and mints 25,000 mUSD in one transaction", () => {
    const [faucetKey, auth, mint, wallet] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey) as PublicKey[];
    const ixs = faucetInstructions({
      faucet: faucetKey!,
      mintAuthority: auth!,
      mint: mint!,
      wallet: wallet!,
      solLamports: FAUCET_SOL_LAMPORTS,
      musdAmount: FAUCET_MUSD,
    });
    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(FAUCET_SOL_LAMPORTS).toBe(50_000_000n);
    expect(FAUCET_MUSD).toBe(25_000_000_000n);
    // mintTo data: [7, amount u64 LE]
    const data = ixs[2]!.data;
    expect(data[0]).toBe(7);
    expect(data.readBigUInt64LE(1)).toBe(FAUCET_MUSD);
  });
});

// ---------- oracle ----------

function market(over: Partial<MarketView> = {}): MarketView {
  return {
    pubkey: Keypair.generate().publicKey,
    homeowner: Keypair.generate().publicKey,
    marketNonce: 1n,
    propertyId: 1,
    latE6: 34_045_000,
    lonE6: -118_526_000,
    scenarioId: 1,
    triggerDistanceM: 500,
    coverageTarget: 10_000n * MUSD_UNIT,
    coverageActivated: 0n,
    acceptedCount: 0,
    status: "closed",
    evidenceHash: new Uint8Array(32),
    createdAt: 0n,
    ...over,
  };
}

const registry: ScenarioRegistry = {
  "1": {
    scenarioId: 1,
    name: "palisades-2025",
    title: "Palisades Fire, January 2025",
    file: "test.geojson",
    sha256: "",
    source: "https://example.invalid/source",
    retrieved: "2026-11-21",
  },
};

/** Fake geo that mirrors the agreed contract with sorted-key canonical JSON. */
function fakeGeo(tamper: (r: Record<string, unknown>) => void = () => {}): GeoAdapter {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
          )
        : v;
  return {
    async loadScenarioGeometry() {
      return { type: "MultiPolygon", coordinates: [] };
    },
    async buildEvidence(i) {
      const record = {
        computed: { distance_m: 0, inside: true },
        dataset: { name: i.scenario.name, retrieved: i.scenario.retrieved, sha256: i.scenario.sha256, source: i.scenario.source },
        market: i.market,
        program_id: i.programId,
        property: i.property,
        scenario_id: i.scenarioId,
        trigger_distance_m: i.triggerDistanceM,
        triggered: true,
        version: 1 as const,
      };
      tamper(record as unknown as Record<string, unknown>);
      const canonical = JSON.stringify(sortKeys(record));
      const hashHex = sha256Hex(canonical);
      return { record, canonical, hashHex, hashBytes: Uint8Array.from(Buffer.from(hashHex, "hex")) };
    },
  };
}

describe("oracle", () => {
  const pid = new PublicKey(loadIdl().address);

  it("only resolves Closed markets", () => {
    expect(() => assertResolvable(market({ status: "closed" }))).not.toThrow();
    expect(() => assertResolvable(market({ status: "open" }))).toThrow(/still Open/);
    expect(() => assertResolvable(market({ status: "resolvedYes" }))).toThrow(/already resolved/);
    expect(() => assertResolvable(market({ status: "resolvedNo" }))).toThrow(/already resolved/);
    expect(() => assertResolvable(market({ status: "voided" }))).toThrow(/voided/);
  });

  it("refuses an unknown scenario_id", async () => {
    await expect(buildMarketEvidence(market({ scenarioId: 7 }), pid, registry, fakeGeo(), "/tmp")).rejects.toThrow(
      /Unknown scenario_id 7/,
    );
  });

  it("builds evidence from on-chain coordinates and checks the hash", async () => {
    const m = market();
    const ev = await buildMarketEvidence(m, pid, registry, fakeGeo(), "/tmp");
    expect(ev.record.property).toEqual({ id: 1, lat_e6: m.latE6, lon_e6: m.lonE6 });
    expect(ev.record.market).toBe(m.pubkey.toBase58());
    expect(sha256Hex(ev.canonical)).toBe(ev.hashHex);
  });

  it("rejects evidence that disagrees with the on-chain market", async () => {
    const bad = fakeGeo((r) => {
      (r.property as { lat_e6: number }).lat_e6 = 1;
    });
    await expect(buildMarketEvidence(market(), pid, registry, bad, "/tmp")).rejects.toThrow(/coordinates/);
  });

  it.each([
    [1, 34_045_000, -118_526_000, true],
    [2, 34_057_000, -118_458_000, false],
  ])("builds canonical evidence for packaged demo property %i", async (propertyId, latE6, lonE6, triggered) => {
    const dir = dataDir();
    const scenarios = loadScenarioRegistry(dir);
    const m = market({ propertyId, latE6, lonE6 });
    const first = await buildMarketEvidence(m, pid, scenarios, realGeo, dir);
    const second = await buildMarketEvidence(m, pid, scenarios, realGeo, dir);
    expect(first.record.triggered).toBe(triggered);
    expect(first.canonical).toBe(second.canonical);
    expect(sha256Hex(first.canonical)).toBe(first.hashHex);
  });

  it("gates JSON, raw evidence and perimeter on finalized settlement and the matching hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrex-ev-"));
    const m = market();
    const ev = await buildMarketEvidence(m, pid, registry, fakeGeo(), dir);
    const path = await writeEvidence(dir, m.pubkey, ev.canonical);
    expect(readFileSync(path, "utf8")).toBe(ev.canonical);
    const key = m.pubkey.toBase58();
    const requests = ["", "?raw=1", "?perimeter=1"];
    for (const status of ["open", "closed", "voided"] as const) {
      for (const query of requests) {
        const denied = await handleEvidence(new Request(`http://x/api${query}`), key, {
          dataDir: dir, readMarket: async () => ({ ...m, status, evidenceHash: ev.hashBytes }),
        });
        expect(denied.status).toBe(404);
        expect(await denied.text()).not.toContain("triggered");
      }
    }
    const opts = { dataDir: dir, readMarket: async () => ({
      ...m, status: "resolvedYes" as const, evidenceHash: ev.hashBytes,
    }) };
    const served = await getEvidence(m.pubkey, opts);
    expect(served.canonical).toBe(ev.canonical);
    const raw = await handleEvidence(new Request("http://x/api?raw=1"), key, opts);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("cache-control")).toBe("no-store");
    expect(await raw.text()).toBe(ev.canonical);

    for (const query of requests) {
      const req = new Request(`http://x/api${query}`);
      const mismatch = await handleEvidence(req, key, {
        dataDir: dir, readMarket: async () => ({ ...m, status: "resolvedYes" }),
      });
      expect(mismatch.status).toBe(503);
      expect(await mismatch.text()).not.toContain("triggered");
      const unavailable = await handleEvidence(req, key, {
        dataDir: dir, readMarket: async () => { throw new Error("RPC offline"); },
      });
      expect(unavailable.status).toBe(503);
    }
  });

  it("publishes real perimeter geometry only when the finalized evidence matches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrex-perimeter-"));
    const registry = loadScenarioRegistry(dataDir());
    const scenario = registry["1"]!;
    const geojson = readFileSync(join(dataDir(), scenario.file));
    writeFileSync(join(dir, "scenarios.json"), JSON.stringify(registry));
    writeFileSync(join(dir, scenario.file), geojson);
    const m = market({ latE6: 34_045_000, lonE6: -118_526_000 });
    const ev = await buildMarketEvidence(m, pid, registry, realGeo, dir);
    await writeEvidence(dir, m.pubkey, ev.canonical);
    const deps = { dataDir: dir, readMarket: async () => ({
      ...m, status: "resolvedYes" as const, evidenceHash: ev.hashBytes,
    }) };
    const req = new Request("http://x/api?perimeter=1");
    const valid = await handleEvidence(req, m.pubkey.toBase58(), deps);
    expect(valid.status).toBe(200);
    expect((await valid.json()).type).toBe("MultiPolygon");
    writeFileSync(join(dir, scenario.file), "tampered");
    const invalid = await handleEvidence(req, m.pubkey.toBase58(), deps);
    expect(invalid.status).toBe(503);
    expect(await invalid.text()).not.toContain(scenario.sha256);
  });

  it("never writes after a failed or unfinalized send, and repairs publication after a late landing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrex-resolve-"));
    writeFileSync(join(dir, "scenarios.json"), JSON.stringify(registry));
    const oracle = Keypair.generate();
    const rpc = new RpcPool(["http://127.0.0.1:8899"]);
    const config = getProgram(rpc.connection).account.config;
    vi.spyOn(config, "fetchNullable").mockResolvedValueOnce({
      oracleAuthority: oracle.publicKey, admin: oracle.publicKey,
      demoController: oracle.publicKey, mint: oracle.publicKey, bump: 0,
    });
    const m = market({ status: "closed" });
    let observed = m;
    const send = vi.fn(async () => { throw new Error("private simulation log"); });
    const deps = { rpc, dataDir: dir, oracle, geo: fakeGeo(), send, readMarket: async () => observed };
    await expect(resolveMarket(m.pubkey, deps)).rejects.toThrow(/not been verified/);
    expect(await readEvidenceBytes(dir, m.pubkey)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);

    const built = await buildMarketEvidence(m, getProgram(rpc.connection).programId, registry, deps.geo, dir);
    observed = { ...m, status: "resolvedYes", evidenceHash: built.hashBytes };
    const repaired = await resolveMarket(m.pubkey, deps);
    expect(repaired.signature).toBeNull();
    expect(await readEvidenceBytes(dir, m.pubkey)).toEqual(Buffer.from(built.canonical));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ---------- HTTP glue (no RPC reached) ----------

describe("route handlers", () => {
  const mk = () => Keypair.generate().publicKey.toBase58();

  it("limits operator password attempts and restores access when the window expires", () => {
    const budget = new OperatorPasswordBudget(2, 60_000);
    expect(budget.check("wrong", "test", 0)).toBe("wrong");
    expect(budget.check("wrong", "test", 1)).toBe("wrong");
    expect(budget.check("test", "test", 59_999)).toBe("limited");
    expect(budget.check("test", "test", 60_000)).toBe("allowed");
  });

  it("close/resolve require the demo password", async () => {
    process.env.DEMO_PASSWORD = "pw";
    const noPw = new Request("http://x/api", { method: "POST" });
    expect((await handleClose(noPw, mk())).status).toBe(403);
    const wrong = new Request("http://x/api", { method: "POST", headers: { "x-demo-password": "nope" } });
    expect((await handleResolve(wrong, mk())).status).toBe(403);
    delete process.env.DEMO_PASSWORD;
    const any = new Request("http://x/api", { method: "POST", headers: { "x-demo-password": "" } });
    const res = await handleClose(any, mk());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/disabled/);
  });

  it("validates the market address", async () => {
    process.env.DEMO_PASSWORD = "pw";
    const req = new Request("http://x/api", { method: "POST", headers: { "x-demo-password": "pw" } });
    expect((await handleResolve(req, "not-a-key")).status).toBe(400);
    expect((await handleEvidence(new Request("http://x/api"), "../../secrets")).status).toBe(400);
    delete process.env.DEMO_PASSWORD;
  });

  it("validates the faucet body", async () => {
    const bad = (body: string) => handleFaucet(new Request("http://x/api", { method: "POST", body }));
    expect((await bad("nope")).status).toBe(400);
    expect((await bad("{}")).status).toBe(400);
    expect((await bad('{"wallet":"abc"}')).status).toBe(400);
  });
});
