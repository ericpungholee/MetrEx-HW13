// MetrEx Exchange v2 Anchor tests, Gate V1 (spec-v2 §13.1): config, property, round, market, split,
// merge, the three settlement paths, redeem, reset and conservation. `assertMarketInvariants` runs
// after every state-changing call. Local `resolution_timeout_s` = 10 (build-plan-v2 §4 A).
// Order instructions are V2 work; their frozen contexts return `NotImplemented` until then.
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
} from "@solana/web3.js";
import {
  burn,
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
  MAX_ROUND_DURATION_S,
  MAX_SPLIT_QTY,
  MIN_RESOLUTION_TIMEOUT_S,
  MUSD_UNIT,
  Outcome,
  PAYOUT_PER_SHARE,
  ResolutionPath,
  SCENARIO_PALISADES_2025,
  findConfigPda,
  findEscrowPda,
  findOrderPda,
  findPropertyPda,
  findRoundPda,
  marketAddresses,
} from "@metrex/exchange";
import { encodeLabel } from "@metrex/shared";
import type { MetrexExchange } from "../target/types/metrex_exchange";
import { makeInvariantChecker, outcomeName, type MusdLedger, type TrackedMarket } from "./helpers/invariants";

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

describe("metrex-exchange (v2, Gate V1)", () => {
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
  const ledger: MusdLedger = { accounts: [], minted: 0n };
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

  function createRound(roundId: number, endsAt: number, previous: PublicKey | null, signer = controller, hash = DATASET_SHA256) {
    return program.methods
      .createRound(SCENARIO_PALISADES_2025, hash, encodeLabel(`Test round ${roundId}`), bn(endsAt))
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
      // Only scenario 1 exists, so a property can never carry a scenario that mismatches its round.
      await expectError(reg(54, 0, 0, 2), "UnsupportedScenario");
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

    it("I6: rejects a second Open round, with or without the previous round account", async () => {
      const endsAt = (await chainNow()) + 3600;
      await expectError(createRound(2, endsAt, round1), "PreviousRoundOpen");
      await expectError(createRound(2, endsAt, null), "PreviousRoundOpen");
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

    it("order instructions keep their frozen context and return NotImplemented until V2", async () => {
      const nonce = 42n;
      const [order] = findOrderPda(pid, M1.market, alice.publicKey, nonce);
      const [escrow] = findEscrowPda(pid, order);
      await expectError(
        program.methods
          .placeOrder(bn(nonce), Outcome.Yes, 0, 430, bn(10), bn(0))
          .accountsPartial({
            maker: alice.publicKey,
            config: configPda,
            round: round1,
            market: M1.market,
            order,
            escrowMint: musd,
            escrow,
            makerSource: ata[alice.publicKey.toBase58()],
            receiveMint: M1.yesMint,
            makerReceive: yesAta(M1, alice),
          })
          .signers([alice])
          .rpc(),
        "NotImplemented",
      );
      await assertMarketInvariants(M1);
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
      await expectError(createRound(2, (await chainNow()) + 60, null), "PreviousRoundOpen");
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
});
