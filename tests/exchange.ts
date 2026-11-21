// MetrEx Exchange v2 Anchor tests, Gates V1 and V2 (spec-v2 §13.1): config, property, round, market, split,
// merge, the three settlement paths, redeem, reset and conservation. `assertMarketInvariants` runs
// after every state-changing call. Local `resolution_timeout_s` = 10 (build-plan-v2 §4 A).
// Gate V2 (orders, fills, matching, cancel, sweep, cutoff, size, demo replay) follows round 2.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as anchor from "@anchor-lang/core";
import { AnchorError, BN, Program } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  burn,
  closeAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  INVALID_PAYOUT_PER_SHARE,
  MAX_RESOLUTION_TIMEOUT_S,
  MAX_ORDER_QTY,
  MAX_ROUND_DURATION_S,
  MAX_SPLIT_QTY,
  MIN_RESOLUTION_TIMEOUT_S,
  MUSD_UNIT,
  OrderSide,
  Outcome,
  PAYOUT_PER_SHARE,
  ResolutionPath,
  SCENARIO_PALISADES_2025,
  SCENARIO_HURRICANES_2017_09,
  SCENARIO_SOUTH_NAPA_2014_08,
  SCENARIO_IOWA_TORNADOES_2024_05,
  findConfigPda,
  findEscrowPda,
  findOrderPda,
  findPropertyPda,
  findRoundPda,
  marketAddresses,
  quote,
} from "@metrex/exchange";
import { encodeLabel } from "@metrex/shared";
import type { MetrexExchange } from "../target/types/metrex_exchange";
import {
  makeInvariantChecker,
  outcomeName,
  type MusdLedger,
  type TrackedMarket,
  type TrackedOrder,
} from "./helpers/invariants";

const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const CONFIRMED = { commitment: "confirmed" as const };
const LOCAL_TIMEOUT_S = 10;

const m = (whole: number | bigint): bigint => BigInt(whole) * MUSD_UNIT;
const bn = (v: bigint | number): BN => new BN(v.toString());
const sha = (s: string | Buffer): number[] => Array.from(createHash("sha256").update(s).digest());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) expect.fail(`expected error ${code}, but the call succeeded`);
  const err = caught as { error?: { errorCode?: { code?: string } }; logs?: string[]; transactionLogs?: string[] };
  if (caught instanceof AnchorError) return void expect(caught.error.errorCode.code).to.equal(code);
  if (err.error?.errorCode?.code) return void expect(err.error.errorCode.code).to.equal(code);
  const logs = err.logs ?? err.transactionLogs ?? [];
  const parsed = AnchorError.parse(logs);
  if (parsed) return void expect(parsed.error.errorCode.code).to.equal(code);
  expect.fail(`expected Anchor error ${code}, got: ${String(caught)}\n${logs.join("\n")}`);
}

async function expectFailureContaining(p: Promise<unknown>, needle: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) expect.fail(`expected failure containing "${needle}"`);
  const err = caught as { logs?: string[]; transactionLogs?: string[] };
  const text = [String(caught), ...(err.logs ?? []), ...(err.transactionLogs ?? [])].join("\n");
  expect(text).to.include(needle);
}

// The three dataset properties (data/DATASET.md). Labels are fictional.
const PROPERTIES = [
  { id: 1, label: "Palisades · Home #1042", lat: 34_045_000, lon: -118_526_000 },
  { id: 2, label: "Westside · Home #2210", lat: 34_057_000, lon: -118_458_000 },
  { id: 3, label: "Palisades · Home #1187", lat: 34_055_000, lon: -118_515_000 },
] as const;
// Test-only property with synthetic coordinates (not a real place), used only to prove that a
// closed round rejects new markets. It never appears in a demo or on Devnet.
const SYNTHETIC_PROPERTY_ID = 99;

describe("metrex-exchange (v2, Gates V1–V2)", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(envProvider.connection, envProvider.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.MetrexExchange as Program<MetrexExchange>;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;
  const parser = new anchor.EventParser(pid, program.coder);

  const [configPda] = findConfigPda(pid);
  const [programData] = PublicKey.findProgramAddressSync([pid.toBuffer()], BPF_UPGRADEABLE_LOADER);

  // admin = the upgrade authority (provider wallet). The other roles are distinct keys (RoleConflict).
  const admin = payer;
  const controller = Keypair.generate();
  const oracle = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate(); // a random outsider: no role, no mUSD
  const mintAuthority = Keypair.generate();

  const DATASET_SHA256 = sha(readFileSync("data/palisades-2025.geojson"));

  let musd: PublicKey;
  const ata: Record<string, PublicKey> = {};
  const ledger: MusdLedger = { accounts: [], orders: [], minted: 0n };
  const { assertMarketInvariants, assertConservation } = makeInvariantChecker(program, conn, ledger);

  // ---------------- helpers ----------------

  async function chainNow(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    return Number(info!.data.readBigInt64LE(32));
  }
  async function waitUntil(t: number): Promise<void> {
    while ((await chainNow()) < t) await sleep(400);
  }

  async function fund(to: PublicKey, sol: number): Promise<void> {
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: sol * LAMPORTS_PER_SOL })),
    );
  }

  async function faucet(owner: Keypair, whole: number): Promise<PublicKey> {
    const acct = await getOrCreateAssociatedTokenAccount(conn, payer, musd, owner.publicKey, false, "confirmed", CONFIRMED);
    if (!ledger.accounts.some((a) => a.equals(acct.address))) ledger.accounts.push(acct.address);
    if (whole > 0) {
      await mintTo(conn, payer, musd, acct.address, mintAuthority, m(whole), [], CONFIRMED);
      ledger.minted += m(whole);
    }
    return acct.address;
  }

  const bal = async (a: PublicKey): Promise<bigint> => (await getAccount(conn, a, "confirmed")).amount;
  const yesAta = (mk: TrackedMarket, k: Keypair) => getAssociatedTokenAddressSync(mk.yesMint, k.publicKey);
  const noAta = (mk: TrackedMarket, k: Keypair) => getAssociatedTokenAddressSync(mk.noMint, k.publicKey);

  async function events(sig: string) {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return [...parser.parseLogs(tx?.meta?.logMessages ?? [])].map((e): { name: string; data: Record<string, any> } => ({
      name: e.name.toLowerCase(),
      data: Object.fromEntries(Object.entries(e.data as object).map(([k, v]) => [camel(k), v])),
    }));
  }

  function createRound(
    roundId: number,
    endsAt: number,
    previous: PublicKey | null,
    signer = controller,
    hash = DATASET_SHA256,
    scenario = SCENARIO_PALISADES_2025,
  ) {
    return program.methods
      .createRound(scenario, hash, encodeLabel(`Test round ${roundId}`), bn(endsAt))
      .accountsPartial({
        roundController: signer.publicKey,
        config: configPda,
        round: findRoundPda(pid, roundId)[0],
        previousRound: previous,
      })
      .signers([signer])
      .rpc();
  }

  function track(label: string, round: PublicKey, propertyId: number): TrackedMarket {
    const a = marketAddresses(pid, round, propertyId);
    return { label, round, propertyId, ...a, dirty: false };
  }

  function createMarket(mk: TrackedMarket, signer = controller) {
    return program.methods
      .createMarket()
      .accountsPartial({
        roundController: signer.publicKey,
        config: configPda,
        round: mk.round,
        property: findPropertyPda(pid, mk.propertyId)[0],
        market: mk.market,
        yesMint: mk.yesMint,
        noMint: mk.noMint,
        collateralMint: musd,
        vault: mk.vault,
      })
      .signers([signer])
      .rpc();
  }

  type SplitOverrides = Partial<{ yesMint: PublicKey; noMint: PublicKey; holderCollateral: PublicKey }>;
  function split(mk: TrackedMarket, who: Keypair, q: bigint | number, o: SplitOverrides = {}) {
    const yesMint = o.yesMint ?? mk.yesMint;
    const noMint = o.noMint ?? mk.noMint;
    return program.methods
      .split(bn(q))
      .accountsPartial({
        holder: who.publicKey,
        config: configPda,
        round: mk.round,
        market: mk.market,
        yesMint,
        noMint,
        vault: mk.vault,
        collateralMint: musd,
        holderCollateral: o.holderCollateral ?? ata[who.publicKey.toBase58()],
        holderYes: getAssociatedTokenAddressSync(yesMint, who.publicKey),
        holderNo: getAssociatedTokenAddressSync(noMint, who.publicKey),
      })
      .signers([who])
      .rpc();
  }

  type MergeOverrides = Partial<{ holderYes: PublicKey; holderNo: PublicKey; holderCollateral: PublicKey }>;
  function merge(mk: TrackedMarket, who: Keypair, q: bigint | number, o: MergeOverrides = {}) {
    return program.methods
      .merge(bn(q))
      .accountsPartial({
        holder: who.publicKey,
        config: configPda,
        round: mk.round,
        market: mk.market,
        yesMint: mk.yesMint,
        noMint: mk.noMint,
        vault: mk.vault,
        collateralMint: musd,
        holderCollateral: o.holderCollateral ?? ata[who.publicKey.toBase58()],
        holderYes: o.holderYes ?? yesAta(mk, who),
        holderNo: o.holderNo ?? noAta(mk, who),
      })
      .signers([who])
      .rpc();
  }

  type RedeemOverrides = Partial<{ outcomeMint: PublicKey; holderShares: PublicKey; holderCollateral: PublicKey }>;
  function redeem(mk: TrackedMarket, who: Keypair, outcome: number, q: bigint | number, o: RedeemOverrides = {}) {
    const outcomeMint = o.outcomeMint ?? (outcome === Outcome.Yes ? mk.yesMint : mk.noMint);
    return program.methods
      .redeem(outcome, bn(q))
      .accountsPartial({
        holder: who.publicKey,
        config: configPda,
        market: mk.market,
        outcomeMint,
        vault: mk.vault,
        holderShares: o.holderShares ?? getAssociatedTokenAddressSync(outcomeMint, who.publicKey),
        holderCollateral: o.holderCollateral ?? ata[who.publicKey.toBase58()],
      })
      .signers([who])
      .rpc();
  }

  function closeRound(round: PublicKey, caller: Keypair = controller) {
    return program.methods.closeRound().accountsPartial({ caller: caller.publicKey, config: configPda, round }).signers([caller]).rpc();
  }

  function resolve(mk: TrackedMarket, triggered: boolean, signer: Keypair = oracle, hash = sha(`evidence:${mk.market.toBase58()}`)) {
    return program.methods
      .resolveMarket(triggered, hash)
      .accountsPartial({ oracleAuthority: signer.publicKey, config: configPda, round: mk.round, market: mk.market })
      .signers([signer])
      .rpc();
  }

  function invalidate(mk: TrackedMarket, adminKp: Keypair, oracleKp: Keypair, reason = 7) {
    return program.methods
      .invalidateMarket(reason)
      .accountsPartial({
        admin: adminKp.publicKey,
        oracleAuthority: oracleKp.publicKey,
        config: configPda,
        round: mk.round,
        market: mk.market,
      })
      .signers(adminKp === payer ? [oracleKp] : [adminKp, oracleKp])
      .rpc();
  }

  function expire(mk: TrackedMarket, caller: Keypair = carol) {
    return program.methods
      .expireMarket()
      .accountsPartial({ caller: caller.publicKey, config: configPda, round: mk.round, market: mk.market })
      .signers([caller])
      .rpc();
  }

  /** Raw bytes, lamports and owner of every account, for the reset test. */
  async function snapshot(keys: PublicKey[]) {
    const infos = await conn.getMultipleAccountsInfo(keys, "confirmed");
    return infos.map((i, n) => {
      expect(i, `account ${keys[n].toBase58()} exists`).to.not.equal(null);
      return { data: Buffer.from(i!.data).toString("hex"), lamports: i!.lamports, owner: i!.owner.toBase58() };
    });
  }

  // ---------------- state shared across the ordered tests ----------------

  const [round1] = findRoundPda(pid, 1);
  const [round2] = findRoundPda(pid, 2);
  const M1 = track("R1/#1042", round1, 1); // resolves YES (oracle)
  const M2 = track("R1/#2210", round1, 2); // resolves NO (oracle)
  const M3 = track("R1/#1187", round1, 3); // emergency Invalid (admin + oracle)
  const M4 = track("R2/#1042", round2, 1); // liveness expiry to Invalid
  const ALL = [M1, M2, M3];
  let round2EndsAt = 0;

  before(async () => {
    for (const k of [controller, oracle, alice, bob, carol]) await fund(k.publicKey, 5);
    musd = await createMint(conn, payer, mintAuthority.publicKey, null, 6, undefined, CONFIRMED);
    ata[alice.publicKey.toBase58()] = await faucet(alice, 10_000);
    ata[bob.publicKey.toBase58()] = await faucet(bob, 10_000);
    ata[carol.publicKey.toBase58()] = await faucet(carol, 0);
  });

  // ================= Config (§6.1, I7) =================

  describe("initialize_config", () => {
    const init = (signer: Keypair, rc: PublicKey, oa: PublicKey, timeout: number, mint = musd) =>
      program.methods
        .initializeConfig(rc, oa, bn(timeout))
        .accountsPartial({ admin: signer.publicKey, config: configPda, collateralMint: mint, program: pid, programData })
        .signers(signer === payer ? [] : [signer])
        .rpc();

    it("I7: rejects a signer that is not the upgrade authority", async () => {
      await expectError(init(alice, controller.publicKey, oracle.publicKey, LOCAL_TIMEOUT_S), "Unauthorized");
    });

    it("rejects overlapping or empty roles (RoleConflict)", async () => {
      await expectError(init(admin, controller.publicKey, controller.publicKey, LOCAL_TIMEOUT_S), "RoleConflict");
      await expectError(init(admin, admin.publicKey, oracle.publicKey, LOCAL_TIMEOUT_S), "RoleConflict");
      await expectError(init(admin, controller.publicKey, admin.publicKey, LOCAL_TIMEOUT_S), "RoleConflict");
      await expectError(init(admin, PublicKey.default, oracle.publicKey, LOCAL_TIMEOUT_S), "RoleConflict");
    });

    it("rejects a collateral mint with a freeze authority or wrong decimals", async () => {
      const frozen = await createMint(conn, payer, mintAuthority.publicKey, mintAuthority.publicKey, 6, undefined, CONFIRMED);
      const nineDp = await createMint(conn, payer, mintAuthority.publicKey, null, 9, undefined, CONFIRMED);
      await expectError(init(admin, controller.publicKey, oracle.publicKey, LOCAL_TIMEOUT_S, frozen), "InvalidMintConfig");
      await expectError(init(admin, controller.publicKey, oracle.publicKey, LOCAL_TIMEOUT_S, nineDp), "InvalidMintConfig");
    });

    it("checks the resolution timeout bounds at init", async () => {
      await expectError(init(admin, controller.publicKey, oracle.publicKey, MIN_RESOLUTION_TIMEOUT_S - 1), "InvalidTimeout");
      await expectError(init(admin, controller.publicKey, oracle.publicKey, MAX_RESOLUTION_TIMEOUT_S + 1), "InvalidTimeout");
    });

    it("initializes once with distinct roles from Config only", async () => {
      await init(admin, controller.publicKey, oracle.publicKey, LOCAL_TIMEOUT_S);
      const c = await program.account.config.fetch(configPda);
      expect(c.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(c.roundController.toBase58()).to.equal(controller.publicKey.toBase58());
      expect(c.oracleAuthority.toBase58()).to.equal(oracle.publicKey.toBase58());
      expect(c.collateralMint.toBase58()).to.equal(musd.toBase58());
      expect(c.latestRound.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(c.nextRoundId.toNumber()).to.equal(1);
      expect(c.resolutionTimeoutS.toNumber()).to.equal(LOCAL_TIMEOUT_S);
      expect(c.version).to.equal(2);
      await expectFailureContaining(init(admin, controller.publicKey, oracle.publicKey, LOCAL_TIMEOUT_S), "already in use");
    });
  });

  // ================= Properties (§6.2) =================

  describe("register_property", () => {
    const reg = (id: number, lat: number, lon: number, scenario = SCENARIO_PALISADES_2025, trigger = 500, signer = admin) =>
      program.methods
        .registerProperty(id, encodeLabel(`Test property #${id}`), lat, lon, scenario, trigger)
        .accountsPartial({ admin: signer.publicKey, config: configPda, property: findPropertyPda(pid, id)[0] })
        .signers(signer === payer ? [] : [signer])
        .rpc();

    it("registers the three dataset properties", async () => {
      for (const p of PROPERTIES) {
        await program.methods
          .registerProperty(p.id, encodeLabel(p.label), p.lat, p.lon, SCENARIO_PALISADES_2025, 500)
          .accountsPartial({ admin: admin.publicKey, config: configPda, property: findPropertyPda(pid, p.id)[0] })
          .rpc();
        const acct = await program.account.property.fetch(findPropertyPda(pid, p.id)[0]);
        expect(acct.latE6).to.equal(p.lat);
        expect(acct.lonE6).to.equal(p.lon);
        expect(acct.triggerDistanceM).to.equal(500);
      }
      await reg(SYNTHETIC_PROPERTY_ID, 1_234_567, -2_345_678);
    });

    it("rejects non-admin, bad coordinates, zero trigger, other scenarios and duplicates", async () => {
      await expectError(reg(50, 0, 0, SCENARIO_PALISADES_2025, 500, alice), "Unauthorized");
      await expectError(reg(51, 90_000_001, 0), "InvalidCoordinates");
      await expectError(reg(52, 0, -180_000_001), "InvalidCoordinates");
      await expectError(reg(53, 0, 0, SCENARIO_PALISADES_2025, 0), "InvalidTriggerDistance");
      // Multi-peril: scenarios 1–4 exist; 0 and 5 do not.
      await expectError(reg(54, 0, 0, 5), "UnsupportedScenario");
      await expectError(reg(55, 0, 0, 0), "UnsupportedScenario");
      // Point scenarios (hurricane 2, earthquake 3) need trigger 0; distance scenarios (1, 4) need > 0.
      await expectError(reg(56, 0, 0, SCENARIO_HURRICANES_2017_09, 500), "InvalidTriggerDistance");
      await expectError(reg(57, 0, 0, SCENARIO_SOUTH_NAPA_2014_08, 1), "InvalidTriggerDistance");
      await expectError(reg(58, 0, 0, SCENARIO_IOWA_TORNADOES_2024_05, 0), "InvalidTriggerDistance");
      await expectFailureContaining(reg(1, 0, 0), "already in use");
    });
  });

  // ================= Round 1 (§6.3, I6) =================

  describe("round 1: create_round and create_market", () => {
    it("validates the deadline, dataset hash and signer", async () => {
      const now = await chainNow();
      await expectError(createRound(1, now - 1, null), "InvalidDeadline");
      await expectError(createRound(1, now + MAX_ROUND_DURATION_S + 60, null), "InvalidDeadline");
      await expectError(createRound(1, now + 3600, null, controller, new Array(32).fill(0)), "InvalidEvidenceHash");
      await expectError(createRound(1, now + 3600, null, alice), "Unauthorized");
    });

    it("opens round 1 and records it as Config.latest_round", async () => {
      const sig = await createRound(1, (await chainNow()) + 3600, null);
      const r = await program.account.round.fetch(round1);
      expect(r.roundId.toNumber()).to.equal(1);
      expect(Object.keys(r.status)[0]).to.equal("open");
      expect(r.datasetSha256).to.deep.equal(DATASET_SHA256);
      const c = await program.account.config.fetch(configPda);
      expect(c.latestRound.toBase58()).to.equal(round1.toBase58());
      expect(c.nextRoundId.toNumber()).to.equal(2);
      const ev = await events(sig);
      expect(ev.map((e) => e.name)).to.include("roundcreated");
    });

    it("I2: creates three markets with 0-decimal mints, market mint authority and no freeze authority", async () => {
      for (const mk of ALL) {
        await createMarket(mk);
        ledger.accounts.push(mk.vault);
        const acct = await program.account.market.fetch(mk.market);
        expect(acct.round.toBase58()).to.equal(round1.toBase58());
        expect(acct.yesMint.toBase58()).to.equal(mk.yesMint.toBase58());
        expect(acct.noMint.toBase58()).to.equal(mk.noMint.toBase58());
        expect(acct.pairsOutstanding.toNumber()).to.equal(0);
        expect(acct.nextOrderSeq.toNumber()).to.equal(1);
        expect(outcomeName(acct.outcome)).to.equal("unresolved");
        const p = PROPERTIES.find((x) => x.id === mk.propertyId)!;
        expect(acct.latE6).to.equal(p.lat);
        expect(acct.lonE6).to.equal(p.lon);
        await assertMarketInvariants(mk);
      }
      expect((await program.account.round.fetch(round1)).marketCount).to.equal(3);
    });

    it("I6: rejects a duplicate (round, property) market and a non-controller creator", async () => {
      await expectFailureContaining(createMarket(M1), "already in use");
      // Account init runs before `has_one`, so use a property with no round-1 market yet.
      await expectError(createMarket(track("x", round1, SYNTHETIC_PROPERTY_ID), alice), "Unauthorized");
    });
  });

  // ================= Split / merge (§4.1, §4.3) =================

  describe("split and merge", () => {
    it("I1/I5: split locks exactly q mUSD and mints q YES + q NO", async () => {
      const before = await bal(ata[alice.publicKey.toBase58()]);
      const sig = await split(M1, alice, 300);
      expect(await bal(ata[alice.publicKey.toBase58()])).to.equal(before - m(300));
      expect(await bal(yesAta(M1, alice))).to.equal(300n);
      expect(await bal(noAta(M1, alice))).to.equal(300n);
      expect(await bal(M1.vault)).to.equal(m(300));
      const ev = (await events(sig)).find((e) => e.name === "sharessplit");
      expect(ev?.data.quantity.toString()).to.equal("300");
      expect(ev?.data.amount.toString()).to.equal(m(300).toString());
      await assertMarketInvariants(M1);
    });

    it("merge releases exactly q mUSD; repeated split/merge cycles stay exact", async () => {
      const before = await bal(ata[alice.publicKey.toBase58()]);
      await merge(M1, alice, 50);
      await assertMarketInvariants(M1);
      expect(await bal(ata[alice.publicKey.toBase58()])).to.equal(before + m(50));
      for (let i = 0; i < 4; i++) {
        await split(M1, alice, 7);
        await assertMarketInvariants(M1);
        await merge(M1, alice, 7);
        await assertMarketInvariants(M1);
      }
      await split(M1, alice, 20);
      await assertMarketInvariants(M1);
      expect((await program.account.market.fetch(M1.market)).pairsOutstanding.toNumber()).to.equal(270);
      expect(await bal(ata[alice.publicKey.toBase58()])).to.equal(before + m(50) - m(20));
    });

    it("funds the other markets", async () => {
      await split(M1, bob, 100);
      await assertMarketInvariants(M1);
      await split(M2, bob, 200);
      await assertMarketInvariants(M2);
      await split(M2, alice, 50);
      await assertMarketInvariants(M2);
      await split(M3, alice, 40);
      await assertMarketInvariants(M3);
      await split(M3, bob, 60);
      await assertMarketInvariants(M3);
      // Shares are plain SPL tokens: alice sells 200 NO of M1 to bob off-book.
      await transfer(conn, alice, noAta(M1, alice), noAta(M1, bob), alice, 200, [], CONFIRMED);
      await assertMarketInvariants(M1);
    });

    it("rejects bad quantities and insufficient funds", async () => {
      await expectError(split(M1, alice, 0), "InvalidQuantity");
      await expectError(split(M1, alice, MAX_SPLIT_QTY + 1n), "InvalidQuantity");
      await expectError(split(M1, carol, 1), "InsufficientFunds");
      await expectError(merge(M1, alice, 0), "InvalidQuantity");
      // alice holds 270 YES but only 70 NO now.
      await expectError(merge(M1, alice, 71), "InsufficientFunds");
      await assertMarketInvariants(M1);
    });

    it("I10: rejects another market's mint or another wallet's token account", async () => {
      await expectError(split(M1, alice, 1, { yesMint: M2.yesMint }), "InvalidMint");
      await expectError(split(M1, alice, 1, { noMint: M2.noMint }), "InvalidMint");
      await expectError(split(M1, alice, 1, { holderCollateral: ata[bob.publicKey.toBase58()] }), "InvalidTokenAccount");
      await expectError(merge(M1, alice, 1, { holderYes: yesAta(M2, alice) }), "InvalidMint");
      await expectError(merge(M1, alice, 1, { holderNo: noAta(M1, bob) }), "InvalidTokenAccount");
      await expectError(merge(M1, alice, 1, { holderCollateral: ata[bob.publicKey.toBase58()] }), "InvalidTokenAccount");
      for (const mk of ALL) await assertMarketInvariants(mk);
    });

    it("I2: nobody but split can mint outcome tokens", async () => {
      await expectFailureContaining(
        mintTo(conn, payer, M1.yesMint, yesAta(M1, alice), payer, 1, [], CONFIRMED),
        "owner does not match",
      );
      await assertMarketInvariants(M1);
    });

    it("I1: an unsolicited vault deposit and a holder self-burn keep backing at ≥", async () => {
      await transfer(conn, alice, ata[alice.publicKey.toBase58()], M1.vault, alice, 1n, [], CONFIRMED);
      await burn(conn, alice, yesAta(M1, alice), M1.yesMint, alice, 1, [], CONFIRMED);
      M1.dirty = true;
      await assertMarketInvariants(M1);
      // Merge pays booked amounts only, and still works.
      await merge(M1, bob, 10);
      await assertMarketInvariants(M1);
      await split(M1, bob, 10);
      await assertMarketInvariants(M1);
      expect((await program.account.market.fetch(M1.market)).pairsOutstanding.toNumber()).to.equal(370);
      expect(await bal(M1.vault)).to.equal(m(370) + 1n);
    });
  });

  // ================= Lifecycle and settlement (§4.5, I6, I8) =================

  describe("round 1: close and settle", () => {
    it("rejects every settlement path and redemption before close", async () => {
      await expectError(resolve(M1, true), "RoundNotClosed");
      await expectError(invalidate(M1, admin, oracle), "RoundNotClosed");
      await expectError(expire(M1), "RoundNotClosed");
      await expectError(redeem(M1, alice, Outcome.Yes, 1), "MarketNotResolved");
    });

    it("I6: an outsider cannot close before trading_ends_at", async () => {
      await expectError(closeRound(round1, carol), "Unauthorized");
    });

    it("I8: the controller closes; the oracle resolves YES and NO inside the window", async () => {
      const sig = await closeRound(round1);
      const r = await program.account.round.fetch(round1);
      expect(Object.keys(r.status)[0]).to.equal("closed");
      expect((await events(sig)).find((e) => e.name === "roundclosed")?.data.byController).to.equal(true);
      // T = closed_at + 10 s: settle first, check afterwards.
      await expectError(resolve(M1, true, carol), "Unauthorized");
      await resolve(M1, true);
      const sig2 = await resolve(M2, false);
      for (const mk of ALL) await assertMarketInvariants(mk);
      const a1 = await program.account.market.fetch(M1.market);
      expect(outcomeName(a1.outcome)).to.equal("yes");
      expect(a1.resolutionPath).to.equal(ResolutionPath.Oracle);
      expect(a1.evidenceHash).to.deep.equal(sha(`evidence:${M1.market.toBase58()}`));
      const ev = (await events(sig2)).find((e) => e.name === "marketresolved");
      expect(ev?.data.outcome).to.equal(2);
      expect(ev?.data.path).to.equal(ResolutionPath.Oracle);
    });

    it("I6: split, create_market and a second close fail after close; merge still works", async () => {
      await expectError(split(M3, alice, 1), "RoundNotOpen");
      await expectError(closeRound(round1), "RoundNotOpen");
      await expectError(createMarket(track("late", round1, SYNTHETIC_PROPERTY_ID)), "RoundNotOpen");
      const before = await bal(ata[alice.publicKey.toBase58()]);
      await merge(M3, alice, 5);
      expect(await bal(ata[alice.publicKey.toBase58()])).to.equal(before + m(5));
      await assertMarketInvariants(M3);
    });

    it("I8: emergency invalidation needs both admin and oracle", async () => {
      await expectError(invalidate(M3, admin, carol), "Unauthorized"); // admin only
      await expectError(invalidate(M3, carol, oracle), "Unauthorized"); // oracle only
      await expectError(invalidate(M3, oracle, controller), "Unauthorized"); // wrong role pair
      const sig = await invalidate(M3, admin, oracle, 9);
      const a3 = await program.account.market.fetch(M3.market);
      expect(outcomeName(a3.outcome)).to.equal("invalid");
      expect(a3.resolutionPath).to.equal(ResolutionPath.Emergency);
      expect(a3.invalidReason).to.equal(9);
      const ev = (await events(sig)).find((e) => e.name === "marketresolved");
      expect(ev?.data.path).to.equal(ResolutionPath.Emergency);
      expect(ev?.data.reason).to.equal(9);
      expect((await program.account.round.fetch(round1)).resolvedCount).to.equal(3);
      await assertMarketInvariants(M3);
    });

    it("I8: each market resolves once; every other path fails with MarketResolved", async () => {
      for (const mk of ALL) {
        await expectError(resolve(mk, false), "MarketResolved");
        await expectError(invalidate(mk, admin, oracle), "MarketResolved");
        await expectError(expire(mk), "MarketResolved");
        await expectError(merge(mk, bob, 1), "MarketResolved");
        await assertMarketInvariants(mk);
      }
    });
  });

  // ================= Reset (§12) =================

  describe("reset via a new round", () => {
    const round1Accounts = () => [
      round1,
      ...PROPERTIES.map((p) => findPropertyPda(pid, p.id)[0]),
      ...ALL.flatMap((mk) => [mk.market, mk.yesMint, mk.noMint, mk.vault]),
    ];
    let snap: Awaited<ReturnType<typeof snapshot>>;

    it("round 2 opens without touching any byte of round 1", async () => {
      snap = await snapshot(round1Accounts());
      round2EndsAt = (await chainNow()) + 8;
      await createRound(2, round2EndsAt, round1);
      await expectError(closeRound(round2, carol), "Unauthorized"); // before trading_ends_at
      await createMarket(M4);
      ledger.accounts.push(M4.vault);
      await split(M4, alice, 10);
      await assertMarketInvariants(M4);
      expect(await snapshot(round1Accounts())).to.deep.equal(snap);
      const c = await program.account.config.fetch(configPda);
      expect(c.latestRound.toBase58()).to.equal(round2.toBase58());
      expect(c.nextRoundId.toNumber()).to.equal(3);
      // Same property, new round, new market and mints.
      expect(M4.market.toBase58()).to.not.equal(M1.market.toBase58());
    });

    it("I6: a market in the closed round 1 is rejected; round 1 stays closed to trading", async () => {
      await expectError(createMarket(track("late", round1, SYNTHETIC_PROPERTY_ID)), "RoundNotOpen");
      await expectError(split(M2, bob, 1), "RoundNotOpen");
    });
  });

  // ================= Redeem (§4.4, I9) =================

  describe("round 1 redemptions", () => {
    it("I9: YES pays 1 mUSD per share, partial then full; NO is rejected", async () => {
      const aliceMusd = ata[alice.publicKey.toBase58()];
      const before = await bal(aliceMusd);
      const sig = await redeem(M1, alice, Outcome.Yes, 100);
      expect(await bal(aliceMusd)).to.equal(before + m(100));
      const ev = (await events(sig)).find((e) => e.name === "sharesredeemed");
      expect(ev?.data.payout.toString()).to.equal(m(100).toString());
      await assertMarketInvariants(M1);
      await redeem(M1, alice, Outcome.Yes, 169); // 270 − 1 self-burned − 100
      expect(await bal(aliceMusd)).to.equal(before + m(269));
      expect(await bal(yesAta(M1, alice))).to.equal(0n);
      await assertMarketInvariants(M1);
      await expectError(redeem(M1, alice, Outcome.Yes, 1), "InsufficientFunds"); // double redeem
      await expectError(redeem(M1, bob, Outcome.No, 1), "LosingOutcome");
      const bobBefore = await bal(ata[bob.publicKey.toBase58()]);
      await redeem(M1, bob, Outcome.Yes, 100);
      expect(await bal(ata[bob.publicKey.toBase58()])).to.equal(bobBefore + m(100));
      await assertMarketInvariants(M1);
    });

    it("I9: rejects redirection, the wrong mint and unknown outcomes", async () => {
      await expectError(redeem(M2, bob, Outcome.No, 1, { holderCollateral: ata[alice.publicKey.toBase58()] }), "InvalidTokenAccount");
      await expectError(redeem(M2, bob, Outcome.No, 1, { holderShares: noAta(M2, alice) }), "InvalidTokenAccount");
      await expectError(redeem(M2, bob, Outcome.No, 1, { outcomeMint: M2.yesMint, holderShares: noAta(M2, bob) }), "InvalidMint");
      await expectError(redeem(M2, bob, Outcome.No, 1, { outcomeMint: M1.noMint, holderShares: noAta(M1, bob) }), "InvalidMint");
      await expectError(redeem(M2, bob, 2, 1), "InvalidOutcome");
      await expectError(redeem(M2, bob, Outcome.No, 0), "InvalidQuantity");
      await assertMarketInvariants(M2);
    });

    it("I9: NO pays 1 mUSD per share; YES is rejected", async () => {
      await expectError(redeem(M2, bob, Outcome.Yes, 1), "LosingOutcome");
      const b = await bal(ata[bob.publicKey.toBase58()]);
      const a = await bal(ata[alice.publicKey.toBase58()]);
      await redeem(M2, bob, Outcome.No, 200);
      await redeem(M2, alice, Outcome.No, 50);
      expect(await bal(ata[bob.publicKey.toBase58()])).to.equal(b + m(200));
      expect(await bal(ata[alice.publicKey.toBase58()])).to.equal(a + m(50));
      expect(await bal(M2.vault)).to.equal(0n);
      await assertMarketInvariants(M2);
    });

    it("I9: Invalid pays 0.5 mUSD per share of either outcome", async () => {
      const a = await bal(ata[alice.publicKey.toBase58()]);
      const b = await bal(ata[bob.publicKey.toBase58()]);
      await redeem(M3, alice, Outcome.Yes, 35); // 40 − 5 merged after close
      await assertMarketInvariants(M3);
      await redeem(M3, alice, Outcome.No, 35);
      await redeem(M3, bob, Outcome.Yes, 60);
      await redeem(M3, bob, Outcome.No, 60);
      expect(await bal(ata[alice.publicKey.toBase58()])).to.equal(a + 70n * INVALID_PAYOUT_PER_SHARE);
      expect(await bal(ata[bob.publicKey.toBase58()])).to.equal(b + 120n * INVALID_PAYOUT_PER_SHARE);
      expect(await bal(M3.vault)).to.equal(0n);
      await assertMarketInvariants(M3);
    });

    it("I5: round 1 conserves mUSD end to end; only stranded surplus remains", async () => {
      // M1: 370 pairs backed 370 mUSD + 1 unsolicited. 369 YES redeemed (1 self-burned).
      expect(await bal(M1.vault)).to.equal(m(1) + 1n);
      await assertConservation();
    });
  });

  // ================= Round 2: deadline and liveness expiry (I6, I8) =================

  describe("round 2: deadline close and expiry", () => {
    it("I6: trading stops at trading_ends_at; then anyone may close", async () => {
      await waitUntil(round2EndsAt);
      await expectError(split(M4, alice, 1), "TradingEnded");
      const sig = await closeRound(round2, carol);
      expect((await events(sig)).find((e) => e.name === "roundclosed")?.data.byController).to.equal(false);
      await assertMarketInvariants(M4);
    });

    it("I8: expiry before T fails; the oracle cannot resolve at or after T; anyone expires after T", async () => {
      await expectError(expire(M4), "ResolutionWindowOpen");
      const r = await program.account.round.fetch(round2);
      const T = r.closedAt.toNumber() + LOCAL_TIMEOUT_S;
      await waitUntil(T);
      await expectError(resolve(M4, true), "ResolutionWindowClosed");
      const sig = await expire(M4, carol);
      const a4 = await program.account.market.fetch(M4.market);
      expect(outcomeName(a4.outcome)).to.equal("invalid");
      expect(a4.resolutionPath).to.equal(ResolutionPath.Expiry);
      expect((await events(sig)).find((e) => e.name === "marketresolved")?.data.path).to.equal(ResolutionPath.Expiry);
      await assertMarketInvariants(M4);
      await expectError(resolve(M4, true), "MarketResolved");
      await expectError(invalidate(M4, admin, oracle), "MarketResolved");
      await expectError(expire(M4), "MarketResolved");
    });

    it("I9: expired markets redeem at 0.5 mUSD per share", async () => {
      const a = await bal(ata[alice.publicKey.toBase58()]);
      await redeem(M4, alice, Outcome.Yes, 10);
      await redeem(M4, alice, Outcome.No, 10);
      expect(await bal(ata[alice.publicKey.toBase58()])).to.equal(a + m(10));
      await assertMarketInvariants(M4);
      for (const mk of [...ALL, M4]) await assertMarketInvariants(mk);
      expect(PAYOUT_PER_SHARE).to.equal(2n * INVALID_PAYOUT_PER_SHARE);
    });
  });

  // ================= Gate V2: orders, fills, matching, recovery (§5, I3, I4, I10–I12) =================

  describe("V2 trading protocol", () => {
    const dave = Keypair.generate(); // the presenter: taker and limit-order maker
    const frank = Keypair.generate(); // closes his own ATA before a sweep
    const botA = Keypair.generate();
    const botB = Keypair.generate();
    const botC = Keypair.generate();
    const [round3] = findRoundPda(pid, 3);
    const [round4] = findRoundPda(pid, 4);
    const M5 = track("R3/#1042", round3, 1);
    const M6 = track("R3/#2210 demo book", round3, 2);
    const M7 = track("R4/#1042", round4, 1);

    let nonceSeq = 10_000n;
    let lastSig = "";
    const nonces = new Map<string, bigint>();
    const musdOf = (k: Keypair) => ata[k.publicKey.toBase58()];
    const ataOf = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
    const sharesMint = (mk: TrackedMarket, outcome: number) => (outcome === Outcome.No ? mk.noMint : mk.yesMint);
    const escrowMintOf = (mk: TrackedMarket, o: TrackedOrder) => (o.side === OrderSide.Sell ? sharesMint(mk, o.outcome) : musd);
    const seqOf = async (o: TrackedOrder) => BigInt((await program.account.order.fetch(o.order)).seq.toString());
    const remainingOf = async (o: TrackedOrder) => BigInt((await program.account.order.fetch(o.order)).remainingQty.toString());
    const lamports = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));
    const rentOf = async (o: TrackedOrder) => {
      const [a, b] = await conn.getMultipleAccountsInfo([o.order, o.escrow], "confirmed");
      return BigInt(a!.lamports + b!.lamports);
    };

    async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
      lastSig = await provider.sendAndConfirm(new Transaction().add(...ixs), signers);
      return lastSig;
    }

    /** Sign and send by hand to measure the serialized size and compute units (§13.1 Size). */
    async function sendMeasured(ixs: TransactionInstruction[], signers: Keypair[]) {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(payer, ...signers);
      const raw = tx.serialize(); // throws if over 1,232 bytes
      const sig = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed" });
      await conn.confirmTransaction(sig, "confirmed");
      const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      expect(info?.meta?.err ?? null, "measured transaction succeeded").to.equal(null);
      lastSig = sig;
      return { sig, size: raw.length, cu: info?.meta?.computeUnitsConsumed ?? 0 };
    }

    type PlaceOpts = Partial<{ nonce: bigint; expiresAt: number; escrowMint: PublicKey; receiveMint: PublicKey; makerSource: PublicKey }>;
    async function placeIx(mk: TrackedMarket, maker: Keypair, outcome: number, side: number, price: number, qty: bigint | number, o: PlaceOpts = {}) {
      const nonce = o.nonce ?? nonceSeq++;
      const [order] = findOrderPda(pid, mk.market, maker.publicKey, nonce);
      const [escrow] = findEscrowPda(pid, order);
      const shares = sharesMint(mk, outcome);
      const escrowMint = o.escrowMint ?? (side === OrderSide.Sell ? shares : musd);
      const receiveMint = o.receiveMint ?? (side === OrderSide.Sell ? musd : shares);
      const ix = await program.methods
        .placeOrder(bn(nonce), outcome, side, price, bn(qty), bn(o.expiresAt ?? 0))
        .accountsPartial({
          maker: maker.publicKey,
          config: configPda,
          round: mk.round,
          market: mk.market,
          order,
          escrowMint,
          escrow,
          makerSource: o.makerSource ?? ataOf(escrowMint, maker.publicKey),
          receiveMint,
          makerReceive: ataOf(receiveMint, maker.publicKey),
        })
        .instruction();
      const tracked: TrackedOrder = {
        label: `${mk.label} ${side === OrderSide.Buy ? "BUY" : "SELL"} ${outcome === Outcome.No ? "NO" : "YES"} ${qty}@${price}`,
        market: mk.market,
        order,
        escrow,
        maker: maker.publicKey,
        outcome,
        side,
        priceBps: price,
        open: false,
        dirty: false,
      };
      return { ix, tracked, nonce };
    }

    /** Register an order whose placement instruction landed. */
    function opened(t: TrackedOrder, nonce: bigint): TrackedOrder {
      t.open = true;
      ledger.orders.push(t);
      nonces.set(t.order.toBase58(), nonce);
      return t;
    }

    async function place(mk: TrackedMarket, maker: Keypair, outcome: number, side: number, price: number, qty: bigint | number, o: PlaceOpts = {}) {
      const { ix, tracked, nonce } = await placeIx(mk, maker, outcome, side, price, qty, o);
      await send([ix], [maker]);
      return opened(tracked, nonce);
    }

    const tryPlace = async (mk: TrackedMarket, maker: Keypair, outcome: number, side: number, price: number, qty: bigint | number, o: PlaceOpts = {}) =>
      send([(await placeIx(mk, maker, outcome, side, price, qty, o)).ix], [maker]);

    type TakeOpts = Partial<{
      expectedSeq: bigint;
      market: PublicKey;
      escrow: PublicKey;
      escrowMint: PublicKey;
      receiveMint: PublicKey;
      makerReceive: PublicKey;
      takerSource: PublicKey;
    }>;
    async function takeIx(mk: TrackedMarket, o: TrackedOrder, taker: Keypair, qty: bigint | number, limit: number, v: TakeOpts = {}) {
      const shares = sharesMint(mk, o.outcome);
      const escrowMint = v.escrowMint ?? (o.side === OrderSide.Sell ? shares : musd);
      const receiveMint = v.receiveMint ?? (o.side === OrderSide.Sell ? musd : shares);
      return program.methods
        .takeOrder(bn(qty), limit, bn(v.expectedSeq ?? (await seqOf(o))))
        .accountsPartial({
          taker: taker.publicKey,
          config: configPda,
          round: mk.round,
          market: v.market ?? mk.market,
          order: o.order,
          escrow: v.escrow ?? o.escrow,
          escrowMint,
          receiveMint,
          makerReceive: v.makerReceive ?? ataOf(receiveMint, o.maker),
          takerSource: v.takerSource ?? ataOf(receiveMint, taker.publicKey),
          takerReceive: ataOf(escrowMint, taker.publicKey),
        })
        .instruction();
    }
    const take = async (mk: TrackedMarket, o: TrackedOrder, taker: Keypair, qty: bigint | number, limit: number, v: TakeOpts = {}) =>
      send([await takeIx(mk, o, taker, qty, limit, v)], [taker]);

    async function matchIx(mk: TrackedMarket, buy: TrackedOrder, sell: TrackedOrder, qty: bigint | number, caller: Keypair, outcomeMint?: PublicKey) {
      const om = outcomeMint ?? sharesMint(mk, buy.outcome);
      return program.methods
        .matchOrders(bn(qty))
        .accountsPartial({
          caller: caller.publicKey,
          config: configPda,
          round: mk.round,
          market: mk.market,
          outcomeMint: om,
          collateralMint: musd,
          buyOrder: buy.order,
          buyEscrow: buy.escrow,
          sellOrder: sell.order,
          sellEscrow: sell.escrow,
          buyerShares: ataOf(om, buy.maker),
          buyerCollateral: ataOf(musd, buy.maker),
          sellerCollateral: ataOf(musd, sell.maker),
        })
        .instruction();
    }
    const match = async (mk: TrackedMarket, buy: TrackedOrder, sell: TrackedOrder, qty: bigint | number, caller: Keypair, outcomeMint?: PublicKey) =>
      send([await matchIx(mk, buy, sell, qty, caller, outcomeMint)], [caller]);

    async function cancel(mk: TrackedMarket, o: TrackedOrder, maker: Keypair) {
      const escrowMint = escrowMintOf(mk, o);
      const sig = await send(
        [
          await program.methods
            .cancelOrder()
            .accountsPartial({
              maker: maker.publicKey,
              config: configPda,
              market: mk.market,
              order: o.order,
              escrow: o.escrow,
              escrowMint,
              makerRefund: ataOf(escrowMint, maker.publicKey),
            })
            .instruction(),
        ],
        [maker],
      );
      o.open = false;
      return sig;
    }

    async function sweep(mk: TrackedMarket, o: TrackedOrder, caller: Keypair = carol) {
      const escrowMint = escrowMintOf(mk, o);
      const sig = await send(
        [
          await program.methods
            .sweepOrder()
            .accountsPartial({
              caller: caller.publicKey,
              maker: o.maker,
              config: configPda,
              round: mk.round,
              market: mk.market,
              order: o.order,
              escrow: o.escrow,
              escrowMint,
              makerRefund: ataOf(escrowMint, o.maker),
            })
            .instruction(),
        ],
        [caller],
      );
      o.open = false;
      return sig;
    }

    const filled = async (sig: string) => (await events(sig)).filter((e) => e.name === "orderfilled").map((e) => e.data);
    const check = async (...mks: TrackedMarket[]) => {
      for (const mk of mks) await assertMarketInvariants(mk);
    };

    // Orders reused across the ordered tests.
    let o1: TrackedOrder; // alice BUY YES 100 @ 400 (seq 1, the oldest)
    let o2: TrackedOrder; // bob SELL YES 200 @ 430
    let o4: TrackedOrder; // bob SELL YES 10 @ 460
    let o6: TrackedOrder; // alice SELL YES 10 @ 480
    let od: TrackedOrder; // dave BUY YES 30 @ 470
    let ask: Record<"A" | "B" | "C", TrackedOrder>;
    let bid: Record<"A" | "B" | "C", TrackedOrder>;
    let ds: TrackedOrder; // dave's demo SELL YES 200 @ 410
    let of: TrackedOrder; // frank SELL YES 5 @ 700

    before(async () => {
      for (const k of [dave, frank, botA, botB, botC]) await fund(k.publicKey, 5);
      ata[dave.publicKey.toBase58()] = await faucet(dave, 1_000);
      ata[frank.publicKey.toBase58()] = await faucet(frank, 100);
      for (const b of [botA, botB, botC]) ata[b.publicKey.toBase58()] = await faucet(b, 2_000);
    });

    it("opens round 3 with two markets and funds the makers", async () => {
      await createRound(3, (await chainNow()) + 3600, round2);
      for (const mk of [M5, M6]) {
        await createMarket(mk);
        ledger.accounts.push(mk.vault);
      }
      await split(M5, alice, 1_000);
      await split(M5, bob, 1_000);
      await split(M5, frank, 5);
      for (const b of [botA, botB, botC]) await split(M6, b, 600);
      await split(M6, dave, 20);
      await check(M5, M6);
    });

    describe("place_order (§5.6)", () => {
      it("I3: BUY escrows q × price × 100 mUSD, SELL escrows q shares, seq increments", async () => {
        const a0 = await bal(musdOf(alice));
        o1 = await place(M5, alice, Outcome.Yes, OrderSide.Buy, 400, 100);
        expect(await bal(o1.escrow)).to.equal(quote(100n, 400));
        expect(await bal(musdOf(alice))).to.equal(a0 - 4_000_000n);
        const acct = await program.account.order.fetch(o1.order);
        expect(acct.seq.toNumber()).to.equal(1);
        expect(acct.remainingQty.toNumber()).to.equal(100);
        expect(acct.originalQty.toNumber()).to.equal(100);
        expect(acct.maker.toBase58()).to.equal(alice.publicKey.toBase58());
        await check(M5);

        const y0 = await bal(yesAta(M5, bob));
        o2 = await place(M5, bob, Outcome.Yes, OrderSide.Sell, 430, 200);
        expect(await bal(o2.escrow)).to.equal(200n);
        expect(await bal(yesAta(M5, bob))).to.equal(y0 - 200n);
        const ev = (await events(lastSig)).find((e) => e.name === "orderplaced");
        expect(ev?.data.seq.toString()).to.equal("2");
        expect(ev?.data.priceBps).to.equal(430);
        expect(ev?.data.quantity.toString()).to.equal("200");
        expect((await program.account.market.fetch(M5.market)).nextOrderSeq.toNumber()).to.equal(3);
        await check(M5);
      });

      it("rejects bad price, quantity, outcome, side and expiry", async () => {
        const Y = Outcome.Yes;
        const B = OrderSide.Buy;
        await expectError(tryPlace(M5, alice, Y, B, 0, 1), "InvalidPrice");
        await expectError(tryPlace(M5, alice, Y, B, 10_000, 1), "InvalidPrice");
        await expectError(tryPlace(M5, alice, Y, B, 400, 0), "InvalidQuantity");
        await expectError(tryPlace(M5, alice, Y, B, 400, MAX_ORDER_QTY + 1n), "InvalidQuantity");
        await expectError(tryPlace(M5, alice, 2, B, 400, 1), "InvalidOutcome");
        await expectError(tryPlace(M5, alice, Y, 2, 400, 1), "InvalidSide");
        await expectError(tryPlace(M5, alice, Y, B, 400, 1, { expiresAt: (await chainNow()) - 1 }), "InvalidExpiry");
        await check(M5);
      });

      it("I10: rejects mints that don't match the order or the market, and another wallet's source", async () => {
        const Y = Outcome.Yes;
        await expectError(tryPlace(M5, alice, Y, OrderSide.Sell, 430, 1, { escrowMint: musd, receiveMint: M5.noMint }), "InvalidMint");
        await expectError(tryPlace(M5, alice, Y, OrderSide.Buy, 400, 1, { receiveMint: M6.yesMint }), "InvalidMint");
        await expectError(tryPlace(M5, botA, Y, OrderSide.Sell, 430, 1, { escrowMint: M6.yesMint }), "InvalidMint");
        await expectError(tryPlace(M5, alice, Y, OrderSide.Buy, 400, 1, { makerSource: musdOf(bob) }), "InvalidTokenAccount");
        await check(M5, M6);
      });

      it("rejects insufficient balances, with no overflow at the largest quote", async () => {
        await expectError(tryPlace(M5, carol, Outcome.Yes, OrderSide.Buy, 1, 1), "InsufficientFunds");
        await expectError(tryPlace(M5, alice, Outcome.Yes, OrderSide.Sell, 430, 5_000), "InsufficientFunds");
        // MAX_ORDER_QTY × 9,999 × 100 = 999,900 mUSD: representable, just unaffordable.
        await expectError(tryPlace(M5, alice, Outcome.Yes, OrderSide.Buy, 9_999, MAX_ORDER_QTY), "InsufficientFunds");
        await check(M5);
      });

      it("accepts price 1 and 9,999 and quantity 1 and MAX_ORDER_QTY; cancel returns escrow and rent", async () => {
        const m0 = await bal(musdOf(alice));
        const y0 = await bal(yesAta(M5, alice));
        const lo = await place(M5, alice, Outcome.Yes, OrderSide.Buy, 1, MAX_ORDER_QTY);
        expect(await bal(lo.escrow)).to.equal(quote(MAX_ORDER_QTY, 1)); // 100 mUSD
        const hi = await place(M5, alice, Outcome.Yes, OrderSide.Sell, 9_999, 1);
        await check(M5);
        const l0 = await lamports(alice.publicKey);
        const rent = (await rentOf(lo)) + (await rentOf(hi));
        const sig = await cancel(M5, lo, alice);
        const ev = (await events(sig)).find((e) => e.name === "ordercancelled");
        expect(ev?.data.swept).to.equal(false);
        expect(ev?.data.returnedAmount.toString()).to.equal(quote(MAX_ORDER_QTY, 1).toString());
        await cancel(M5, hi, alice);
        expect(await bal(musdOf(alice))).to.equal(m0);
        expect(await bal(yesAta(M5, alice))).to.equal(y0);
        expect(await lamports(alice.publicKey)).to.equal(l0 + rent);
        await check(M5);
      });

      it("rejects reusing an open order's nonce", async () => {
        await expectFailureContaining(
          tryPlace(M5, bob, Outcome.Yes, OrderSide.Sell, 431, 1, { nonce: nonces.get(o2.order.toBase58())! }),
          "already in use",
        );
      });
    });

    describe("take_order (§5.7)", () => {
      it("I4: a taker buys from a SELL at its price; the escrow pays the shares", async () => {
        const d0 = await bal(musdOf(dave));
        const b0 = await bal(musdOf(bob));
        const sig = await take(M5, o2, dave, 50, 430);
        expect(await bal(musdOf(dave))).to.equal(d0 - 2_150_000n);
        expect(await bal(musdOf(bob))).to.equal(b0 + 2_150_000n);
        expect(await bal(yesAta(M5, dave))).to.equal(50n);
        expect(await remainingOf(o2)).to.equal(150n);
        const [f] = await filled(sig);
        expect(f.buyOrder.toBase58()).to.equal(PublicKey.default.toBase58());
        expect(f.sellOrder.toBase58()).to.equal(o2.order.toBase58());
        expect(f.makerOrder.toBase58()).to.equal(o2.order.toBase58());
        expect(f.buyer.toBase58()).to.equal(dave.publicKey.toBase58());
        expect(f.seller.toBase58()).to.equal(bob.publicKey.toBase58());
        expect(f.priceBps).to.equal(430);
        expect(f.quantity.toString()).to.equal("50");
        expect(f.quoteAmount.toString()).to.equal("2150000");
        expect(f.buyerRefund.toString()).to.equal("0");
        await check(M5);
      });

      it("I4: rejects a fill outside the taker's limit, on both sides", async () => {
        await expectError(take(M5, o2, dave, 1, 429), "PriceLimitExceeded");
        await expectError(take(M5, o1, dave, 1, 401), "PriceLimitExceeded");
        await check(M5);
      });

      it("I4: a taker sells into a BUY at its price", async () => {
        const d0 = await bal(musdOf(dave));
        const ay0 = await bal(yesAta(M5, alice));
        await take(M5, o1, dave, 30, 400);
        expect(await bal(musdOf(dave))).to.equal(d0 + 1_200_000n);
        expect(await bal(yesAta(M5, dave))).to.equal(20n);
        expect(await bal(yesAta(M5, alice))).to.equal(ay0 + 30n);
        expect(await remainingOf(o1)).to.equal(70n);
        await check(M5);
      });

      it("I4/I11: a take never exceeds remaining; a filled order rejects takes and anyone sweeps it", async () => {
        const d0 = await bal(musdOf(dave));
        const sig = await take(M5, o2, dave, 1_000, 430);
        expect((await filled(sig))[0].quantity.toString()).to.equal("150");
        expect(await bal(musdOf(dave))).to.equal(d0 - quote(150n, 430));
        expect(await bal(yesAta(M5, dave))).to.equal(170n);
        expect(await remainingOf(o2)).to.equal(0n);
        await check(M5);
        await expectError(take(M5, o2, dave, 1, 430), "OrderNotActive");

        const l0 = await lamports(bob.publicKey);
        const rent = await rentOf(o2);
        const s = await sweep(M5, o2, carol);
        expect(await lamports(bob.publicKey)).to.equal(l0 + rent);
        const ev = (await events(s)).find((e) => e.name === "ordercancelled");
        expect(ev?.data.swept).to.equal(true);
        expect(ev?.data.returnedAmount.toString()).to.equal("0");
        await check(M5);
        // A closed order can't be filled.
        await expectError(take(M5, o2, dave, 1, 430, { expectedSeq: 2n }), "AccountNotInitialized");
      });

      it("I11: expected_seq defeats ABA when a nonce is cancelled and re-placed at a worse price", async () => {
        const n = nonceSeq++;
        const a1 = await place(M5, bob, Outcome.Yes, OrderSide.Sell, 440, 10, { nonce: n });
        const s1 = await seqOf(a1);
        await cancel(M5, a1, bob);
        await check(M5);
        ledger.orders.splice(ledger.orders.indexOf(a1), 1); // the PDA is about to be reused
        const a2 = await place(M5, bob, Outcome.Yes, OrderSide.Sell, 600, 10, { nonce: n });
        expect(a2.order.toBase58()).to.equal(a1.order.toBase58());
        const s2 = await seqOf(a2);
        expect(s2 > s1).to.equal(true);
        await expectError(take(M5, a2, dave, 10, 700, { expectedSeq: s1 }), "OrderSeqMismatch");
        await expectError(take(M5, a2, dave, 10, 599, { expectedSeq: s2 }), "PriceLimitExceeded");
        await cancel(M5, a2, bob);
        await check(M5);
      });

      it("two takers race for one order: the second gets the remainder, the third fails", async () => {
        const o3 = await place(M5, bob, Outcome.Yes, OrderSide.Sell, 450, 30);
        await take(M5, o3, dave, 20, 450);
        const a0 = await bal(musdOf(alice));
        const sig = await take(M5, o3, alice, 20, 450);
        expect((await filled(sig))[0].quantity.toString()).to.equal("10");
        expect(await bal(musdOf(alice))).to.equal(a0 - quote(10n, 450));
        await expectError(take(M5, o3, frank, 1, 450), "OrderNotActive");
        await check(M5);
      });

      it("I12: self-trade is rejected", async () => {
        o4 = await place(M5, bob, Outcome.Yes, OrderSide.Sell, 460, 10);
        await expectError(take(M5, o4, bob, 1, 460), "SelfTrade");
        await check(M5);
      });

      it("I10: rejects other markets' accounts, a foreign escrow and redirected payments", async () => {
        await expectError(take(M5, o4, dave, 1, 460, { market: M6.market }), "OrderMismatch");
        await expectError(
          take(M5, o4, dave, 1, 460, { receiveMint: M6.yesMint, makerReceive: ataOf(musd, bob.publicKey), takerSource: musdOf(dave) }),
          "InvalidMint",
        );
        await expectError(take(M5, o4, dave, 1, 460, { escrow: o1.escrow }), "ConstraintSeeds");
        await expectError(take(M5, o4, dave, 1, 460, { escrowMint: M5.noMint }), "InvalidMint");
        await expectError(take(M5, o4, dave, 1, 460, { makerReceive: musdOf(dave) }), "InvalidTokenAccount");
        await expectError(take(M5, o4, dave, 1, 460, { takerSource: musdOf(alice) }), "InvalidTokenAccount");
        // A real mint of this market, but the wrong counter-asset for a SELL order.
        await expectError(
          take(M5, o4, alice, 1, 460, { receiveMint: M5.noMint, makerReceive: noAta(M5, bob), takerSource: noAta(M5, alice) }),
          "InvalidMint",
        );
        await check(M5, M6);
      });
    });

    describe("match_orders (§5.5)", () => {
      it("I4: an older BUY against a newer SELL executes at the BUY price with no refund (one-tx limit order)", async () => {
        const b0 = await bal(musdOf(bob));
        const ay0 = await bal(yesAta(M5, alice));
        const p = await placeIx(M5, bob, Outcome.Yes, OrderSide.Sell, 390, 50);
        const sig = await send([p.ix, await matchIx(M5, o1, p.tracked, 50, bob)], [bob]);
        const o5 = opened(p.tracked, p.nonce);
        expect(await bal(musdOf(bob))).to.equal(b0 + quote(50n, 400));
        expect(await bal(yesAta(M5, alice))).to.equal(ay0 + 50n);
        expect(await remainingOf(o1)).to.equal(20n);
        expect(await remainingOf(o5)).to.equal(0n);
        const [f] = await filled(sig);
        expect(f.priceBps).to.equal(400);
        expect(f.buyerRefund.toString()).to.equal("0");
        expect(f.makerOrder.toBase58()).to.equal(o1.order.toBase58());
        await check(M5);
      });

      it("I4: an older SELL against a newer BUY executes at the SELL price and refunds the buyer exactly", async () => {
        const d0 = await bal(musdOf(dave));
        const b0 = await bal(musdOf(bob));
        const p = await placeIx(M5, dave, Outcome.Yes, OrderSide.Buy, 470, 30);
        const sig = await send([p.ix, await matchIx(M5, p.tracked, o4, 30, dave)], [dave]);
        od = opened(p.tracked, p.nonce);
        // Escrowed 30 × 470, paid 10 × 460, refunded 10 × (470 − 460); 20 × 470 stays reserved.
        expect(await bal(musdOf(dave))).to.equal(d0 - quote(30n, 470) + 10n * 10n * 100n);
        expect(await bal(musdOf(bob))).to.equal(b0 + quote(10n, 460));
        expect(await bal(od.escrow)).to.equal(quote(20n, 470));
        expect(await remainingOf(od)).to.equal(20n);
        const [f] = await filled(sig);
        expect(f.priceBps).to.equal(460);
        expect(f.buyerRefund.toString()).to.equal("10000");
        expect(f.makerOrder.toBase58()).to.equal(o4.order.toBase58());
        await check(M5);
      });

      it("rejects uncrossed, mis-sided, mixed-outcome and self-trade matches", async () => {
        o6 = await place(M5, alice, Outcome.Yes, OrderSide.Sell, 480, 10);
        await expectError(match(M5, od, o6, 10, carol), "OrdersDoNotCross");
        await expectError(match(M5, o6, od, 10, carol), "InvalidSide");
        const o7 = await place(M5, alice, Outcome.No, OrderSide.Buy, 600, 10);
        await expectError(match(M5, o7, o6, 10, carol, M5.noMint), "OrderMismatch");
        const o8 = await place(M5, alice, Outcome.Yes, OrderSide.Buy, 485, 10);
        await expectError(match(M5, o8, o6, 10, carol), "SelfTrade");
        await cancel(M5, o7, alice);
        await cancel(M5, o8, alice);
        await check(M5);
      });

      it("one escrow fills in two matches in the same transaction, then is exhausted", async () => {
        const o9 = await place(M5, bob, Outcome.Yes, OrderSide.Sell, 465, 10);
        const o10 = await place(M5, alice, Outcome.Yes, OrderSide.Sell, 468, 10);
        const b0 = await bal(musdOf(bob));
        const a0 = await bal(musdOf(alice));
        const dy0 = await bal(yesAta(M5, dave));
        const sig = await send([await matchIx(M5, od, o9, 10, carol), await matchIx(M5, od, o10, 10, carol)], [carol]);
        expect((await filled(sig)).map((f) => f.priceBps)).to.deep.equal([470, 470]); // od is older
        expect(await bal(musdOf(bob))).to.equal(b0 + quote(10n, 470));
        expect(await bal(musdOf(alice))).to.equal(a0 + quote(10n, 470));
        expect(await bal(yesAta(M5, dave))).to.equal(dy0 + 20n);
        expect(await remainingOf(od)).to.equal(0n);
        expect(await bal(od.escrow)).to.equal(0n);
        await expectError(match(M5, od, o6, 1, carol), "OrderNotActive");
        await check(M5);
      });

      it("expired orders can't fill and become sweepable", async () => {
        const t = (await chainNow()) + 3;
        const oe = await place(M5, alice, Outcome.Yes, OrderSide.Buy, 300, 10, { expiresAt: t });
        await expectError(sweep(M5, oe, carol), "NotSweepable");
        oe.open = true;
        await waitUntil(t);
        await expectError(take(M5, oe, dave, 1, 300), "OrderExpired");
        await expectError(match(M5, oe, o6, 1, carol), "OrderExpired");
        const a0 = await bal(musdOf(alice));
        await sweep(M5, oe, carol);
        expect(await bal(musdOf(alice))).to.equal(a0 + quote(10n, 300));
        await check(M5);
      });

      it("I11: cancel after a partial fill returns the whole escrow, unsolicited surplus included, and the rent", async () => {
        await transfer(conn, alice, musdOf(alice), o1.escrow, alice, 1n, [], CONFIRMED);
        o1.dirty = true;
        await check(M5);
        await expectError(cancel(M5, o1, bob), "Unauthorized");
        o1.open = true;
        const m0 = await bal(musdOf(alice));
        const l0 = await lamports(alice.publicKey);
        const rent = await rentOf(o1);
        const sig = await cancel(M5, o1, alice);
        expect(await bal(musdOf(alice))).to.equal(m0 + quote(20n, 400) + 1n);
        expect(await lamports(alice.publicKey)).to.equal(l0 + rent);
        const ev = (await events(sig)).find((e) => e.name === "ordercancelled");
        expect(ev?.data.returnedAmount.toString()).to.equal((quote(20n, 400) + 1n).toString());
        expect(ev?.data.remainingQty.toString()).to.equal("20");
        await check(M5);
      });
    });

    describe("demo replay on a clean book (§11)", () => {
      it("three bots quote the featured ladder", async () => {
        const Y = Outcome.Yes;
        ask = {
          A: await place(M6, botA, Y, OrderSide.Sell, 430, 200),
          B: await place(M6, botB, Y, OrderSide.Sell, 500, 150),
          C: await place(M6, botC, Y, OrderSide.Sell, 590, 100),
        };
        bid = {
          C: await place(M6, botC, Y, OrderSide.Buy, 410, 100),
          B: await place(M6, botB, Y, OrderSide.Buy, 400, 150),
          A: await place(M6, botA, Y, OrderSide.Buy, 370, 200),
        };
        await check(M6);
      });

      it("the presenter market-buys 300 YES across two levels for exactly 13.6 mUSD", async () => {
        const d0 = await bal(musdOf(dave));
        const y0 = await bal(yesAta(M6, dave));
        const sig = await send([await takeIx(M6, ask.A, dave, 200, 500), await takeIx(M6, ask.B, dave, 100, 500)], [dave]);
        expect(await bal(musdOf(dave))).to.equal(d0 - 13_600_000n);
        expect(await bal(yesAta(M6, dave))).to.equal(y0 + 300n);
        expect((await filled(sig)).map((f) => [f.priceBps, f.quantity.toString()])).to.deep.equal([
          [430, "200"],
          [500, "100"],
        ]);
        expect(await remainingOf(ask.B)).to.equal(50n);
        await check(M6);
      });

      it("the presenter sells 200 @ 410: 100 fill against Bot C at once and 100 rest", async () => {
        const d0 = await bal(musdOf(dave));
        const p = await placeIx(M6, dave, Outcome.Yes, OrderSide.Sell, 410, 200);
        const sig = await send([p.ix, await matchIx(M6, bid.C, p.tracked, 200, dave)], [dave]);
        ds = opened(p.tracked, p.nonce);
        const [f] = await filled(sig);
        expect(f.quantity.toString()).to.equal("100");
        expect(f.priceBps).to.equal(410);
        expect(await bal(musdOf(dave))).to.equal(d0 + 4_100_000n);
        expect(await remainingOf(ds)).to.equal(100n);
        expect(await remainingOf(bid.C)).to.equal(0n);
        // Bot B's 400 bid is below the presenter's limit: the remainder keeps resting.
        await expectError(match(M6, bid.B, ds, 100, carol), "OrdersDoNotCross");
        await check(M6);
      });

      it("size: a 4-level market order and a 3-level limit order each fit in one transaction, with every event", async () => {
        const N = Outcome.No;
        const asks = [
          await place(M6, botA, N, OrderSide.Sell, 9_500, 5),
          await place(M6, botB, N, OrderSide.Sell, 9_501, 5),
          await place(M6, botC, N, OrderSide.Sell, 9_502, 5),
          await place(M6, botA, N, OrderSide.Sell, 9_503, 5),
        ];
        const d0 = await bal(musdOf(dave));
        const n0 = await bal(noAta(M6, dave));
        const take4 = await sendMeasured(await Promise.all(asks.map((a) => takeIx(M6, a, dave, 5, 9_503))), [dave]);
        expect(take4.size).to.be.at.most(1_232);
        expect((await filled(take4.sig)).length).to.equal(4);
        expect(await bal(musdOf(dave))).to.equal(d0 - quote(5n, 9_500) - quote(5n, 9_501) - quote(5n, 9_502) - quote(5n, 9_503));
        expect(await bal(noAta(M6, dave))).to.equal(n0 + 20n);
        await check(M6);

        const bids = [
          await place(M6, botA, N, OrderSide.Buy, 9_000, 5),
          await place(M6, botB, N, OrderSide.Buy, 8_990, 5),
          await place(M6, botC, N, OrderSide.Buy, 8_980, 5),
        ];
        const d1 = await bal(musdOf(dave));
        const p = await placeIx(M6, dave, N, OrderSide.Sell, 8_900, 15);
        const limit3 = await sendMeasured(
          [p.ix, ...(await Promise.all(bids.map((b) => matchIx(M6, b, p.tracked, 15, dave))))],
          [dave],
        );
        const sellNo = opened(p.tracked, p.nonce);
        expect(limit3.size).to.be.at.most(1_232);
        const ev = await events(limit3.sig);
        expect(ev.filter((e) => e.name === "orderplaced").length).to.equal(1);
        expect(ev.filter((e) => e.name === "orderfilled").map((e) => e.data.priceBps)).to.deep.equal([9_000, 8_990, 8_980]);
        expect(await bal(musdOf(dave))).to.equal(d1 + quote(5n, 9_000) + quote(5n, 8_990) + quote(5n, 8_980));
        expect(await remainingOf(sellNo)).to.equal(0n);
        console.log(
          `      size: 4-level take ${take4.size} B / ${take4.cu} CU; place + 3 matches ${limit3.size} B / ${limit3.cu} CU`,
        );
        await check(M6);
      });
    });

    describe("cutoff and recovery (§5.8, §5.9)", () => {
      it("an active order in an open round can't be swept", async () => {
        await expectError(sweep(M6, ds, carol), "NotSweepable");
        ds.open = true;
      });

      it("frank escrows all his YES, then closes his empty share account", async () => {
        of = await place(M5, frank, Outcome.Yes, OrderSide.Sell, 700, 5);
        expect(await bal(yesAta(M5, frank))).to.equal(0n);
        await closeAccount(conn, payer, yesAta(M5, frank), frank.publicKey, frank, [], CONFIRMED);
        expect(await conn.getAccountInfo(yesAta(M5, frank), "confirmed")).to.equal(null);
        await check(M5);
      });

      it("I6: closing round 3 stops place, take and match on every market; merge works until resolution", async () => {
        await closeRound(round3);
        await merge(M5, alice, 1); // before resolution, inside the oracle window
        await resolve(M5, true); // resolution succeeds while orders are still escrowed
        await resolve(M6, false);
        await expectError(tryPlace(M6, botA, Outcome.Yes, OrderSide.Sell, 450, 1), "RoundNotOpen");
        await expectError(take(M6, ask.B, dave, 1, 500), "RoundNotOpen");
        await expectError(match(M6, bid.B, ds, 1, carol), "RoundNotOpen");
        await expectError(split(M5, alice, 1), "RoundNotOpen");
        await check(M5, M6);
      });

      it("I11: cancel works after close and resolution", async () => {
        const b0 = await bal(musdOf(botB));
        await cancel(M6, bid.B, botB);
        expect(await bal(musdOf(botB))).to.equal(b0 + quote(150n, 400));
        await cancel(M5, o6, alice);
        await check(M5, M6);
      });

      it("I11: anyone sweeps after close; escrow and rent go to the maker; a closed ATA is recreated at the caller's cost", async () => {
        const dy0 = await bal(yesAta(M6, dave));
        const dl0 = await lamports(dave.publicKey);
        const dRent = await rentOf(ds);
        await sweep(M6, ds, carol);
        expect(await bal(yesAta(M6, dave))).to.equal(dy0 + 100n);
        expect(await lamports(dave.publicKey)).to.equal(dl0 + dRent);

        const fl0 = await lamports(frank.publicKey);
        const cl0 = await lamports(carol.publicKey);
        const fRent = await rentOf(of);
        await sweep(M5, of, carol);
        expect(await bal(yesAta(M5, frank))).to.equal(5n);
        expect(await lamports(frank.publicKey)).to.equal(fl0 + fRent);
        expect((await lamports(carol.publicKey)) < cl0, "the caller paid for frank's new ATA").to.equal(true);
        await check(M5, M6);
      });

      it("I9: redemption after a sweep pays exactly; every remaining order sweeps back to its maker", async () => {
        const f0 = await bal(musdOf(frank));
        await redeem(M5, frank, Outcome.Yes, 5);
        expect(await bal(musdOf(frank))).to.equal(f0 + m(5));
        for (const o of ledger.orders.filter((x) => x.open && (x.market.equals(M5.market) || x.market.equals(M6.market)))) {
          await sweep(o.market.equals(M5.market) ? M5 : M6, o, carol);
        }
        await check(M5, M6);
        const d0 = await bal(musdOf(dave));
        const dn = await bal(noAta(M6, dave));
        await redeem(M6, dave, Outcome.No, dn);
        expect(await bal(musdOf(dave))).to.equal(d0 + dn * PAYOUT_PER_SHARE);
        await check(M5, M6);
      });
    });

    describe("deadline cutoff (round 4)", () => {
      it("I6: orders stop at trading_ends_at, and sweep works before anyone closes the round", async () => {
        const endsAt = (await chainNow()) + 6;
        await createRound(4, endsAt, round3);
        await createMarket(M7);
        ledger.accounts.push(M7.vault);
        await split(M7, alice, 10);
        const s7 = await place(M7, alice, Outcome.Yes, OrderSide.Sell, 500, 5);
        const b7 = await place(M7, dave, Outcome.Yes, OrderSide.Buy, 400, 5);
        await check(M7);
        await waitUntil(endsAt);
        await expectError(tryPlace(M7, alice, Outcome.Yes, OrderSide.Sell, 500, 1), "TradingEnded");
        await expectError(take(M7, s7, dave, 1, 500), "TradingEnded");
        await expectError(match(M7, b7, s7, 1, carol), "TradingEnded");
        const a0 = await bal(yesAta(M7, alice));
        const d0 = await bal(musdOf(dave));
        await sweep(M7, s7, carol);
        await sweep(M7, b7, carol);
        expect(await bal(yesAta(M7, alice))).to.equal(a0 + 5n);
        expect(await bal(musdOf(dave))).to.equal(d0 + quote(5n, 400));
        await closeRound(round4, carol);
        await check(M7);
      });
    });
  });

  // ================= Multi-peril (docs/spec-multiperil.md §2) =================

  describe("multi-peril: one round per hazard, open at the same time", () => {
    const HURRICANE_PROPERTY = 104;
    const QUAKE_PROPERTY = 105;
    const TORNADO_PROPERTY = 106;
    const hazardHash = (n: string) => [...createHash("sha256").update(`dataset:${n}`).digest()];
    const [round5] = findRoundPda(pid, 5);
    const [round6] = findRoundPda(pid, 6);
    const [round7] = findRoundPda(pid, 7);
    const H = track("R5/hurricane", round5, HURRICANE_PROPERTY);
    const Q = track("R6/earthquake", round6, QUAKE_PROPERTY);
    const T = track("R7/tornado", round7, TORNADO_PROPERTY);
    const wrong = track("R5/tornado property", round5, TORNADO_PROPERTY);

    it("registers one property per new hazard with its trigger convention", async () => {
      const regH = (id: number, lat: number, lon: number, scenario: number, trigger: number) =>
        program.methods
          .registerProperty(id, encodeLabel(`Hazard property #${id}`), lat, lon, scenario, trigger)
          .accountsPartial({ admin: admin.publicKey, config: configPda, property: findPropertyPda(pid, id)[0] })
          .rpc();
      await regH(HURRICANE_PROPERTY, 25_722_000, -80_278_000, SCENARIO_HURRICANES_2017_09, 0);
      await regH(QUAKE_PROPERTY, 38_254_000, -122_292_000, SCENARIO_SOUTH_NAPA_2014_08, 0);
      await regH(TORNADO_PROPERTY, 41_699_000, -93_729_000, SCENARIO_IOWA_TORNADOES_2024_05, 500);
      const q = await program.account.property.fetch(findPropertyPda(pid, QUAKE_PROPERTY)[0]);
      expect(q.scenarioId).to.equal(SCENARIO_SOUTH_NAPA_2014_08);
      expect(q.triggerDistanceM).to.equal(0);
    });

    it("opens three rounds of different scenarios concurrently, each with its own deadline", async () => {
      const now = await chainNow();
      await expectError(createRound(5, now + 3600, null, controller, hazardHash("x"), 5), "UnsupportedScenario");
      await createRound(5, now + 3600, null, controller, hazardHash("hurricane"), SCENARIO_HURRICANES_2017_09);
      await createRound(6, now + 7200, round5, controller, hazardHash("earthquake"), SCENARIO_SOUTH_NAPA_2014_08);
      await createRound(7, now + 5400, null, controller, hazardHash("tornado"), SCENARIO_IOWA_TORNADOES_2024_05);
      for (const [r, s] of [[round5, 2], [round6, 3], [round7, 4]] as const) {
        const acct = await program.account.round.fetch(r);
        expect(Object.keys(acct.status)[0]).to.equal("open");
        expect(acct.scenarioId).to.equal(s);
      }
      expect((await program.account.config.fetch(configPda)).latestRound.toBase58()).to.equal(round7.toBase58());
    });

    it("binds each market to its round's scenario", async () => {
      await expectError(createMarket(wrong), "ScenarioMismatch");
      for (const mk of [H, Q, T]) {
        await createMarket(mk);
        ledger.accounts.push(mk.vault);
        const acct = await program.account.market.fetch(mk.market);
        expect(acct.round.toBase58()).to.equal(mk.round.toBase58());
      }
      expect((await program.account.market.fetch(Q.market)).triggerDistanceM).to.equal(0);
      expect((await program.account.market.fetch(T.market)).triggerDistanceM).to.equal(500);
    });

    it("fractional-cent prices: a 1 bps (0.01¢) quote is exact", async () => {
      for (const mk of [H, Q, T]) await split(mk, alice, 1_000);
      // 100,000 shares at 1 bps = 100,000 × 1 × 100 base units = 10 mUSD; at 80 bps = 800 mUSD.
      expect(quote(100_000n, 1)).to.equal(10_000_000n);
      expect(quote(100_000n, 80)).to.equal(800_000_000n);
      for (const mk of [H, Q, T]) await assertMarketInvariants(mk);
    });

    it("closing one hazard's round stops only that round; the others keep trading", async () => {
      await closeRound(round5);
      await expectError(split(H, alice, 1), "RoundNotOpen");
      await split(Q, alice, 1);
      await split(T, alice, 1);
      await resolve(H, false);
      expect(outcomeName((await program.account.market.fetch(H.market)).outcome)).to.equal("no");
      await expectError(resolve(Q, true), "RoundNotClosed");
      await closeRound(round6);
      await closeRound(round7);
      await resolve(Q, true);
      await resolve(T, true);
      for (const mk of [H, Q, T]) await assertMarketInvariants(mk);
    });
  });
});
