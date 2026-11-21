// Anchor tests (spec §12.1). Every non-Tier-2 §12.1 item, plus one named test per
// §6.3 invariant 1–14 (`inv-N: ...`). Runs on the local validator via `anchor test`.
import * as anchor from "@anchor-lang/core";
import { AnchorError, BN, Program } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  getAccount,
  getMint,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  MAX_ABS_LAT_E6,
  MAX_ABS_LON_E6,
  MAX_COVERAGE_TARGET,
  MIN_COVERAGE,
  MUSD_UNIT,
  computeOfferTerms,
  encodeLabel,
  findConfigPda,
  findMarketPda,
  findOfferPda,
  findPropertyPda,
  findVaultPda,
  randomNonce,
} from "@metrex/shared";
import type { Metrex } from "../target/types/metrex";

const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Whole mUSD → base units. */
const m = (whole: number | bigint): bigint => BigInt(whole) * MUSD_UNIT;
const bn = (v: bigint | number): BN => new BN(v.toString());

/** Setup transactions wait for `confirmed`, so the next transaction's preflight sees them. */
const CONFIRMED = { commitment: "confirmed" as const };

/** Expect `p` to fail with the named Anchor error (custom or framework). */
async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) expect.fail(`expected error ${code}, but the call succeeded`);
  const err = caught as {
    error?: { errorCode?: { code?: string } };
    logs?: string[];
    transactionLogs?: string[];
  };
  if (caught instanceof AnchorError) {
    expect(caught.error.errorCode.code).to.equal(code);
    return;
  }
  if (err.error?.errorCode?.code) {
    expect(err.error.errorCode.code).to.equal(code);
    return;
  }
  // Fallback: parse the program logs for the Anchor error line.
  const logs = err.logs ?? err.transactionLogs ?? [];
  const parsed = AnchorError.parse(logs);
  if (parsed) {
    expect(parsed.error.errorCode.code).to.equal(code);
    return;
  }
  expect.fail(`expected Anchor error ${code}, got: ${String(caught)}\n${logs.join("\n")}`);
}

/** Expect `p` to fail with a non-Anchor error whose message or logs contain `needle`. */
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

describe("metrex", () => {
  const envProvider = anchor.AnchorProvider.env();
  // Confirm and simulate at `confirmed` so every step sees the previous step's state.
  const provider = new anchor.AnchorProvider(envProvider.connection, envProvider.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Metrex as Program<Metrex>;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;

  const [configPda] = findConfigPda(pid);
  const [programData] = PublicKey.findProgramAddressSync([pid.toBuffer()], BPF_UPGRADEABLE_LOADER);

  // `admin` is the provider wallet: `anchor test` deploys the program upgradeable with it as
  // the upgrade authority (spec §6, Anchor.toml [test] upgradeable = true).
  const admin = payer;
  const oracle = Keypair.generate();
  const controller = Keypair.generate();

  let mint: PublicKey; // mUSD, 6 decimals
  let badMint: PublicKey; // another 6-decimal mint, never in Config

  const PROP_ID = 1;
  const PROP_LAT = 1_234_567; // synthetic test coordinates, not a real property
  const PROP_LON = -2_345_678;
  const PROP_SCENARIO = 1;
  const PROP_TRIGGER = 500;

  // ---------------- helpers ----------------

  async function newUser(sol = 10): Promise<Keypair> {
    const kp = Keypair.generate();
    // Funded from the provider wallet (faster than an airdrop on the local validator).
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: kp.publicKey,
          lamports: sol * LAMPORTS_PER_SOL,
        }),
      ),
      [],
      CONFIRMED,
    );
    return kp;
  }

  async function tokenAccount(owner: PublicKey, amount = 0n, mintPk = mint): Promise<PublicKey> {
    const acct = await createAccount(conn, payer, mintPk, owner, Keypair.generate(), CONFIRMED);
    if (amount > 0n) await mintTo(conn, payer, mintPk, acct, payer, amount, [], CONFIRMED);
    return acct;
  }

  async function balance(acct: PublicKey): Promise<bigint> {
    const info = await conn.getAccountInfo(acct);
    if (info === null) return 0n; // closed vault
    return (await getAccount(conn, acct)).amount;
  }

  async function sumBalances(accts: PublicKey[]): Promise<bigint> {
    let total = 0n;
    for (const a of accts) total += await balance(a);
    return total;
  }

  async function exists(addr: PublicKey): Promise<boolean> {
    return (await conn.getAccountInfo(addr)) !== null;
  }

  let marketNonce = 1n;

  async function createMarket(
    homeowner: Keypair,
    target: bigint,
    propertyId = PROP_ID,
  ): Promise<PublicKey> {
    const nonce = marketNonce++;
    const [market] = findMarketPda(pid, homeowner.publicKey, nonce);
    await program.methods
      .createMarket(bn(nonce), propertyId, bn(target))
      .accountsPartial({
        homeowner: homeowner.publicKey,
        property: findPropertyPda(pid, propertyId)[0],
        market,
      })
      .signers([homeowner])
      .rpc();
    return market;
  }

  interface OfferRef {
    offer: PublicKey;
    vault: PublicKey;
  }

  function placeOfferTx(
    market: PublicKey,
    uw: Keypair,
    uwToken: PublicKey,
    coverage: bigint,
    bps: number,
    mintPk: PublicKey = mint,
  ) {
    const nonce = randomNonce();
    const [offer] = findOfferPda(pid, market, uw.publicKey, nonce);
    const [vault] = findVaultPda(pid, offer);
    const builder = program.methods
      .placeOffer(bn(nonce), bn(coverage), bps)
      .accountsPartial({
        underwriter: uw.publicKey,
        config: configPda,
        market,
        offer,
        mint: mintPk,
        vault,
        underwriterToken: uwToken,
      })
      .signers([uw]);
    return { offer, vault, builder };
  }

  async function placeOffer(
    market: PublicKey,
    uw: Keypair,
    uwToken: PublicKey,
    coverage: bigint,
    bps: number,
  ): Promise<OfferRef> {
    const { offer, vault, builder } = placeOfferTx(market, uw, uwToken, coverage, bps);
    await builder.rpc();
    return { offer, vault };
  }

  function acceptOffer(
    market: PublicKey,
    homeowner: Keypair,
    homeownerToken: PublicKey,
    o: OfferRef,
  ): Promise<string> {
    return program.methods
      .acceptOffer()
      .accountsPartial({
        homeowner: homeowner.publicKey,
        config: configPda,
        market,
        offer: o.offer,
        vault: o.vault,
        homeownerToken,
      })
      .signers([homeowner])
      .rpc();
  }

  function cancelOffer(uw: Keypair, uwToken: PublicKey, o: OfferRef): Promise<string> {
    return program.methods
      .cancelOffer()
      .accountsPartial({
        underwriter: uw.publicKey,
        config: configPda,
        offer: o.offer,
        vault: o.vault,
        underwriterToken: uwToken,
      })
      .signers([uw])
      .rpc();
  }

  function closeMarket(market: PublicKey, signer: Keypair = controller): Promise<string> {
    return program.methods
      .closeMarket()
      .accountsPartial({ demoController: signer.publicKey, config: configPda, market })
      .signers([signer])
      .rpc();
  }

  function resolveMarket(
    market: PublicKey,
    triggered: boolean,
    signer: Keypair = oracle,
    hash: number[] = Array.from({ length: 32 }, (_, i) => i + 1),
  ): Promise<string> {
    return program.methods
      .resolveMarket(triggered, hash)
      .accountsPartial({ oracleAuthority: signer.publicKey, config: configPda, market })
      .signers([signer])
      .rpc();
  }

  function claimPayout(
    market: PublicKey,
    claimant: Keypair,
    claimantToken: PublicKey,
    o: OfferRef,
    underwriter: PublicKey,
  ): Promise<string> {
    return program.methods
      .claimPayout()
      .accountsPartial({
        claimant: claimant.publicKey,
        config: configPda,
        market,
        offer: o.offer,
        vault: o.vault,
        claimantToken,
        underwriter,
      })
      .signers([claimant])
      .rpc();
  }

  function voidMarket(market: PublicKey, signer: Keypair = admin): Promise<string> {
    return program.methods
      .voidMarket()
      .accountsPartial({ admin: signer.publicKey, config: configPda, market })
      .signers(signer === admin ? [] : [signer])
      .rpc();
  }

  function refundOffer(
    market: PublicKey,
    o: OfferRef,
    homeownerToken: PublicKey,
    underwriterToken: PublicKey,
    underwriter: PublicKey,
  ): Promise<string> {
    return program.methods
      .refundOffer()
      .accountsPartial({
        config: configPda,
        market,
        offer: o.offer,
        vault: o.vault,
        homeownerToken,
        underwriterToken,
        underwriter,
      })
      .rpc();
  }

  function registerProperty(
    id: number,
    lat: number,
    lon: number,
    trigger = PROP_TRIGGER,
    signer: Keypair = admin,
  ): Promise<string> {
    return program.methods
      .registerProperty(id, encodeLabel(`Test property #${id}`), lat, lon, PROP_SCENARIO, trigger)
      .accountsPartial({
        admin: signer.publicKey,
        config: configPda,
        property: findPropertyPda(pid, id)[0],
      })
      .signers(signer === admin ? [] : [signer])
      .rpc();
  }

  function initConfig(signer: Keypair, oracleKey: PublicKey, controllerKey: PublicKey, mintPk: PublicKey) {
    return program.methods
      .initializeConfig(oracleKey, controllerKey)
      .accountsPartial({
        admin: signer.publicKey,
        config: configPda,
        mint: mintPk,
        program: pid,
        programData,
      })
      .signers(signer === admin ? [] : [signer])
      .rpc();
  }

  /** A funded market with homeowner + three underwriters (§4.3 worked example). */
  interface Fixture {
    homeowner: Keypair;
    hoToken: PublicKey;
    market: PublicKey;
    uws: Keypair[];
    uwTokens: PublicKey[];
    offers: OfferRef[];
  }

  const WORKED = [
    { coverage: m(4_000), bps: 400, premium: m(160), collateral: m(3_840) },
    { coverage: m(3_000), bps: 450, premium: m(135), collateral: m(2_865) },
    { coverage: m(3_000), bps: 500, premium: m(150), collateral: m(2_850) },
  ];

  async function workedExample(accept: boolean): Promise<Fixture> {
    const homeowner = await newUser();
    const hoToken = await tokenAccount(homeowner.publicKey, m(1_000));
    const market = await createMarket(homeowner, m(10_000));
    const uws: Keypair[] = [];
    const uwTokens: PublicKey[] = [];
    const offers: OfferRef[] = [];
    for (const w of WORKED) {
      const uw = await newUser();
      const t = await tokenAccount(uw.publicKey, m(10_000));
      uws.push(uw);
      uwTokens.push(t);
      offers.push(await placeOffer(market, uw, t, w.coverage, w.bps));
    }
    if (accept) {
      for (const o of offers) await acceptOffer(market, homeowner, hoToken, o);
    }
    return { homeowner, hoToken, market, uws, uwTokens, offers };
  }

  /** Simple market with one homeowner and one underwriter. */
  async function simpleMarket(target = m(1_000)) {
    const homeowner = await newUser();
    const hoToken = await tokenAccount(homeowner.publicKey, m(10_000));
    const market = await createMarket(homeowner, target);
    const uw = await newUser();
    const uwToken = await tokenAccount(uw.publicKey, m(10_000));
    return { homeowner, hoToken, market, uw, uwToken };
  }

  before(async () => {
    // Oracle and controller only sign; they get SOL so that a rejected init of an
    // admin-only account fails on authority, not on rent.
    for (const kp of [oracle, controller]) {
      const sig = await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      const bh = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    }
    mint = await createMint(conn, payer, payer.publicKey, null, 6);
    badMint = await createMint(conn, payer, payer.publicKey, null, 6);
  });

  // =====================================================================
  describe("Setup and config", () => {
    it("rejects initialize_config from a signer that is not the upgrade authority", async () => {
      const attacker = await newUser();
      await expectError(
        initConfig(attacker, oracle.publicKey, controller.publicKey, mint),
        "Unauthorized",
      );
    });

    it("rejects initialize_config with oracle == controller", async () => {
      await expectError(
        initConfig(admin, oracle.publicKey, oracle.publicKey, mint),
        "Unauthorized",
      );
    });

    it("rejects initialize_config with a mint that does not have 6 decimals", async () => {
      const mint9 = await createMint(conn, payer, payer.publicKey, null, 9);
      await expectError(
        initConfig(admin, oracle.publicKey, controller.publicKey, mint9),
        "WrongMint",
      );
    });

    it("Config initializes once; a second init fails", async () => {
      await initConfig(admin, oracle.publicKey, controller.publicKey, mint);
      const cfg = await program.account.config.fetch(configPda);
      expect(cfg.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(cfg.oracleAuthority.toBase58()).to.equal(oracle.publicKey.toBase58());
      expect(cfg.demoController.toBase58()).to.equal(controller.publicKey.toBase58());
      expect(cfg.mint.toBase58()).to.equal(mint.toBase58());
      expect(cfg.bump).to.equal(findConfigPda(pid)[1]);

      // `init` on an existing account fails in the System Program.
      await expectFailureContaining(
        initConfig(admin, Keypair.generate().publicKey, Keypair.generate().publicKey, mint),
        "already in use",
      );
      const after = await program.account.config.fetch(configPda);
      expect(after.oracleAuthority.toBase58()).to.equal(oracle.publicKey.toBase58());
    });

    it("registers a property and stores every field", async () => {
      await registerProperty(PROP_ID, PROP_LAT, PROP_LON);
      const [pda, bump] = findPropertyPda(pid, PROP_ID);
      const p = await program.account.property.fetch(pda);
      expect(p.propertyId).to.equal(PROP_ID);
      expect(p.latE6).to.equal(PROP_LAT);
      expect(p.lonE6).to.equal(PROP_LON);
      expect(p.scenarioId).to.equal(PROP_SCENARIO);
      expect(p.triggerDistanceM).to.equal(PROP_TRIGGER);
      expect(p.label).to.deep.equal(encodeLabel(`Test property #${PROP_ID}`));
      expect(p.bump).to.equal(bump);
    });

    it("Non-admin cannot register a property", async () => {
      const attacker = await newUser();
      await expectError(registerProperty(2, 0, 0, PROP_TRIGGER, attacker), "Unauthorized");
    });

    it("rejects invalid coordinates and a zero trigger distance; accepts the exact bounds", async () => {
      const bad: Array<[number, number, number]> = [
        [MAX_ABS_LAT_E6 + 1, 0, 500],
        [-MAX_ABS_LAT_E6 - 1, 0, 500],
        [0, MAX_ABS_LON_E6 + 1, 500],
        [0, -MAX_ABS_LON_E6 - 1, 500],
        [-2_147_483_648, 0, 500], // i32::MIN
        [0, 2_147_483_647, 500], // i32::MAX
        [0, 0, 0], // trigger distance 0
      ];
      let id = 100;
      for (const [lat, lon, trig] of bad) {
        await expectError(registerProperty(id++, lat, lon, trig), "InvalidCoordinates");
      }
      await registerProperty(110, MAX_ABS_LAT_E6, MAX_ABS_LON_E6);
      await registerProperty(111, -MAX_ABS_LAT_E6, -MAX_ABS_LON_E6);
    });

    it("rejects registering the same property ID twice", async () => {
      await expectFailureContaining(registerProperty(PROP_ID, 0, 0), "already in use");
    });
  });

  // =====================================================================
  describe("Market and offers", () => {
    it("Market creation copies property data", async () => {
      const homeowner = await newUser();
      const market = await createMarket(homeowner, m(5_000));
      const mk = await program.account.market.fetch(market);
      expect(mk.homeowner.toBase58()).to.equal(homeowner.publicKey.toBase58());
      expect(mk.propertyId).to.equal(PROP_ID);
      expect(mk.latE6).to.equal(PROP_LAT);
      expect(mk.lonE6).to.equal(PROP_LON);
      expect(mk.scenarioId).to.equal(PROP_SCENARIO);
      expect(mk.triggerDistanceM).to.equal(PROP_TRIGGER);
      expect(mk.coverageTarget.toString()).to.equal(m(5_000).toString());
      expect(mk.coverageActivated.toNumber()).to.equal(0);
      expect(mk.acceptedCount).to.equal(0);
      expect(mk.status).to.deep.equal({ open: {} });
      expect(mk.evidenceHash).to.deep.equal(new Array(32).fill(0));
      expect(mk.createdAt.toNumber()).to.be.greaterThan(0);
      expect(mk.closedAt.toNumber()).to.equal(0);
      expect(mk.resolvedAt.toNumber()).to.equal(0);
    });

    it("unknown property rejected", async () => {
      const homeowner = await newUser();
      await expectError(createMarket(homeowner, m(1_000), 999), "AccountNotInitialized");
    });

    it("target bounds enforced", async () => {
      const homeowner = await newUser();
      await expectError(createMarket(homeowner, MIN_COVERAGE - 1n), "CoverageTooSmall");
      await expectError(createMarket(homeowner, MAX_COVERAGE_TARGET + 1n), "CoverageExceedsTarget");
      await createMarket(homeowner, MIN_COVERAGE);
      await createMarket(homeowner, MAX_COVERAGE_TARGET);
    });

    it("Offer locks exactly K; premium is floor(C×b/10⁴); P + K == C", async () => {
      const { market, uw, uwToken } = await simpleMarket(m(10_000));
      const coverage = m(4_321) + 987_654n;
      const bps = 333;
      const expectedP = (coverage * 333n) / 10_000n; // floor
      const expectedK = coverage - expectedP;
      const before = await balance(uwToken);
      const o = await placeOffer(market, uw, uwToken, coverage, bps);

      expect(await balance(o.vault)).to.equal(expectedK);
      expect(before - (await balance(uwToken))).to.equal(expectedK);
      const off = await program.account.offer.fetch(o.offer);
      expect(BigInt(off.premium.toString())).to.equal(expectedP);
      expect(BigInt(off.collateral.toString())).to.equal(expectedK);
      expect(BigInt(off.premium.toString()) + BigInt(off.collateral.toString())).to.equal(coverage);
      expect(off.premiumBps).to.equal(bps);
      expect(off.status).to.deep.equal({ open: {} });
      expect(off.market.toBase58()).to.equal(market.toBase58());
      expect(off.underwriter.toBase58()).to.equal(uw.publicKey.toBase58());
      expect(off.protectionHolder.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(off.riskHolder.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(off.vaultBump).to.equal(findVaultPda(pid, o.offer)[1]);
      const vault = await getAccount(conn, o.vault);
      expect(vault.mint.toBase58()).to.equal(mint.toBase58());
      expect(vault.owner.toBase58()).to.equal(o.offer.toBase58());
    });

    it("bps 0 and 10,000 rejected; bps 1 and 9,999 accepted", async () => {
      const { market, uw, uwToken } = await simpleMarket();
      await expectError(placeOfferTx(market, uw, uwToken, m(100), 0).builder.rpc(), "InvalidBps");
      await expectError(placeOfferTx(market, uw, uwToken, m(100), 10_000).builder.rpc(), "InvalidBps");
      await expectError(placeOfferTx(market, uw, uwToken, m(100), 65_535).builder.rpc(), "InvalidBps");
      await placeOffer(market, uw, uwToken, m(100), 1);
      await placeOffer(market, uw, uwToken, m(100), 9_999);
    });

    it("premium rounding to zero cannot occur: the smallest offer (C = MIN_COVERAGE, b = 1) has P = 1,000 ≥ 1", async () => {
      // With MIN_COVERAGE = 10 mUSD = 10^7 base units, C × b ≥ 10^7 > 10^4, so P ≥ 1000 for every
      // valid offer and the PremiumRoundsToZero branch is unreachable (reported as a spec note).
      const { market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, MIN_COVERAGE, 1);
      const off = await program.account.offer.fetch(o.offer);
      expect(off.premium.toNumber()).to.equal(1_000);
      expect(off.collateral.toString()).to.equal((MIN_COVERAGE - 1_000n).toString());
    });

    it("C < MIN or C > target rejected; C == target accepted", async () => {
      const { market, uw, uwToken } = await simpleMarket(m(1_000));
      await expectError(
        placeOfferTx(market, uw, uwToken, MIN_COVERAGE - 1n, 400).builder.rpc(),
        "CoverageTooSmall",
      );
      await expectError(
        placeOfferTx(market, uw, uwToken, m(1_000) + 1n, 400).builder.rpc(),
        "CoverageExceedsTarget",
      );
      await placeOffer(market, uw, uwToken, m(1_000), 400);
    });

    it("Insufficient balance rejects offer", async () => {
      const { market } = await simpleMarket(m(1_000));
      const poor = await newUser();
      const { collateral } = computeOfferTerms(m(1_000), 400);
      const poorToken = await tokenAccount(poor.publicKey, collateral - 1n);
      await expectError(
        placeOfferTx(market, poor, poorToken, m(1_000), 400).builder.rpc(),
        "InsufficientFunds",
      );
      // Exactly K is enough.
      await mintTo(conn, payer, mint, poorToken, payer, 1n, [], CONFIRMED);
      const o = await placeOffer(market, poor, poorToken, m(1_000), 400);
      expect(await balance(o.vault)).to.equal(collateral);
      expect(await balance(poorToken)).to.equal(0n);
    });

    it("Homeowner cannot underwrite own market", async () => {
      const { homeowner, hoToken, market } = await simpleMarket();
      await expectError(
        placeOfferTx(market, homeowner, hoToken, m(100), 400).builder.rpc(),
        "SelfUnderwriting",
      );
    });

    it("Wrong mint rejected on place_offer (mint account and underwriter token account)", async () => {
      const { market, uw, uwToken } = await simpleMarket();
      await expectError(
        placeOfferTx(market, uw, uwToken, m(100), 400, badMint).builder.rpc(),
        "WrongMint",
      );
      const badToken = await tokenAccount(uw.publicKey, m(10_000), badMint);
      await expectError(
        placeOfferTx(market, uw, badToken, m(100), 400).builder.rpc(),
        "WrongMint",
      );
    });

    it("Underwriter token account owned by someone else rejected", async () => {
      const { market, uw } = await simpleMarket();
      const other = await newUser();
      const otherToken = await tokenAccount(other.publicKey, m(10_000));
      await expectError(
        placeOfferTx(market, uw, otherToken, m(100), 400).builder.rpc(),
        "WrongTokenOwner",
      );
    });

    it("Two offers from different wallets in the same slot both succeed", async () => {
      const { market } = await simpleMarket(m(1_000));
      const a = await newUser();
      const b = await newUser();
      const aTok = await tokenAccount(a.publicKey, m(1_000));
      const bTok = await tokenAccount(b.publicKey, m(1_000));

      // One transaction (hence one slot) carrying both place_offer instructions.
      const oa = placeOfferTx(market, a, aTok, m(500), 400);
      const ob = placeOfferTx(market, b, bTok, m(500), 450);
      const tx = new Transaction().add(await oa.builder.instruction(), await ob.builder.instruction());
      await provider.sendAndConfirm(tx, [a, b]);
      for (const o of [oa, ob]) {
        const off = await program.account.offer.fetch(o.offer);
        expect(off.status).to.deep.equal({ open: {} });
      }
      expect(await balance(oa.vault)).to.equal(computeOfferTerms(m(500), 400).collateral);
      expect(await balance(ob.vault)).to.equal(computeOfferTerms(m(500), 450).collateral);

      // And two independent transactions sent concurrently.
      const oc = placeOfferTx(market, a, aTok, m(100), 400);
      const od = placeOfferTx(market, b, bTok, m(100), 400);
      await Promise.all([oc.builder.rpc(), od.builder.rpc()]);
      expect(await exists(oc.offer)).to.equal(true);
      expect(await exists(od.offer)).to.equal(true);
    });

    it("Offers on non-Open markets rejected (Closed, ResolvedYes, ResolvedNo, Voided)", async () => {
      const uw = await newUser();
      const uwToken = await tokenAccount(uw.publicKey, m(10_000));

      const closed = await simpleMarket();
      await closeMarket(closed.market);
      await expectError(
        placeOfferTx(closed.market, uw, uwToken, m(100), 400).builder.rpc(),
        "InvalidMarketStatus",
      );

      for (const triggered of [true, false]) {
        const r = await simpleMarket();
        await closeMarket(r.market);
        await resolveMarket(r.market, triggered);
        await expectError(
          placeOfferTx(r.market, uw, uwToken, m(100), 400).builder.rpc(),
          "InvalidMarketStatus",
        );
      }

      const voided = await simpleMarket();
      await voidMarket(voided.market);
      await expectError(
        placeOfferTx(voided.market, uw, uwToken, m(100), 400).builder.rpc(),
        "InvalidMarketStatus",
      );
    });

    it("emits OfferPlaced with the computed terms", async () => {
      const { market, uw, uwToken } = await simpleMarket();
      const p = placeOfferTx(market, uw, uwToken, m(200), 450);
      const sig = await p.builder.rpc({ commitment: "confirmed" });
      const tx = await conn.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const parser = new anchor.EventParser(pid, program.coder);
      const events = [...parser.parseLogs(tx?.meta?.logMessages ?? [])];
      const placed = events.find((e) => e.name.toLowerCase() === "offerplaced");
      expect(placed, "OfferPlaced event").to.not.equal(undefined);
      const data = placed!.data as { offer: PublicKey; premium: BN; collateral: BN };
      expect(data.offer.toBase58()).to.equal(p.offer.toBase58());
      expect(data.premium.toString()).to.equal(m(9).toString());
      expect(data.collateral.toString()).to.equal(m(191).toString());
    });
  });

  // =====================================================================
  describe("Acceptance", () => {
    it("Non-homeowner cannot accept", async () => {
      const { market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      const attacker = await newUser();
      const attackerToken = await tokenAccount(attacker.publicKey, m(1_000));
      await expectError(acceptOffer(market, attacker, attackerToken, o), "Unauthorized");
      // The underwriter cannot accept its own offer either.
      await expectError(acceptOffer(market, uw, uwToken, o), "Unauthorized");
    });

    it("Cancelled or already-accepted offer cannot be accepted", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const cancelled = await placeOffer(market, uw, uwToken, m(100), 400);
      await cancelOffer(uw, uwToken, cancelled);
      // A cancelled offer's vault is closed, so account validation fails before the handler.
      await expectError(acceptOffer(market, homeowner, hoToken, cancelled), "AccountNotInitialized");

      const accepted = await placeOffer(market, uw, uwToken, m(100), 400);
      await acceptOffer(market, homeowner, hoToken, accepted);
      await expectError(acceptOffer(market, homeowner, hoToken, accepted), "InvalidOfferStatus");
      const mk = await program.account.market.fetch(market);
      expect(mk.coverageActivated.toString()).to.equal(m(100).toString());
      expect(mk.acceptedCount).to.equal(1);
    });

    it("Offer from another market rejected", async () => {
      const homeowner = await newUser();
      const hoToken = await tokenAccount(homeowner.publicKey, m(1_000));
      const m1 = await createMarket(homeowner, m(1_000));
      const m2 = await createMarket(homeowner, m(1_000));
      const uw = await newUser();
      const uwToken = await tokenAccount(uw.publicKey, m(1_000));
      const o = await placeOffer(m1, uw, uwToken, m(100), 400);
      await expectError(acceptOffer(m2, homeowner, hoToken, o), "OfferMarketMismatch");
    });

    it("Acceptance that would exceed the target rejected; offers summing past the target can still all be placed", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket(m(100));
      const o1 = await placeOffer(market, uw, uwToken, m(60), 400);
      const o2 = await placeOffer(market, uw, uwToken, m(60), 400);
      const o3 = await placeOffer(market, uw, uwToken, m(40), 400);
      await acceptOffer(market, homeowner, hoToken, o1);
      await expectError(acceptOffer(market, homeowner, hoToken, o2), "CoverageExceedsRemaining");
      await acceptOffer(market, homeowner, hoToken, o3); // exactly fills the target
      const mk = await program.account.market.fetch(market);
      expect(mk.coverageActivated.toString()).to.equal(m(100).toString());
      expect(mk.acceptedCount).to.equal(2);
      expect((await program.account.offer.fetch(o2.offer)).status).to.deep.equal({ open: {} });
    });

    it("Vault equals C after acceptance; premium moves homeowner → vault; holders set", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(250), 420);
      const { premium } = computeOfferTerms(m(250), 420);
      const hoBefore = await balance(hoToken);
      await acceptOffer(market, homeowner, hoToken, o);
      expect(await balance(o.vault)).to.equal(m(250));
      expect(hoBefore - (await balance(hoToken))).to.equal(premium);
      const off = await program.account.offer.fetch(o.offer);
      expect(off.status).to.deep.equal({ accepted: {} });
      expect(off.protectionHolder.toBase58()).to.equal(homeowner.publicKey.toBase58());
      expect(off.riskHolder.toBase58()).to.equal(uw.publicKey.toBase58());
      expect(off.acceptedAt.toNumber()).to.be.greaterThan(0);
    });

    it("Homeowner with insufficient balance cannot accept", async () => {
      const homeowner = await newUser();
      const { premium } = computeOfferTerms(m(1_000), 400);
      const hoToken = await tokenAccount(homeowner.publicKey, premium - 1n);
      const market = await createMarket(homeowner, m(1_000));
      const uw = await newUser();
      const uwToken = await tokenAccount(uw.publicKey, m(1_000));
      const o = await placeOffer(market, uw, uwToken, m(1_000), 400);
      await expectError(acceptOffer(market, homeowner, hoToken, o), "InsufficientFunds");
    });

    it("Accepted offer cannot be cancelled", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      await acceptOffer(market, homeowner, hoToken, o);
      await expectError(cancelOffer(uw, uwToken, o), "InvalidOfferStatus");
      expect(await balance(o.vault)).to.equal(m(100));
    });

    it("Acceptance after close rejected", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      await closeMarket(market);
      await expectError(acceptOffer(market, homeowner, hoToken, o), "InvalidMarketStatus");
    });

    it("Wrong mint rejected on accept_offer and cancel_offer; wrong owner rejected", async () => {
      const { homeowner, market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      const hoBad = await tokenAccount(homeowner.publicKey, m(1_000), badMint);
      await expectError(acceptOffer(market, homeowner, hoBad, o), "WrongMint");
      const uwBad = await tokenAccount(uw.publicKey, 0n, badMint);
      await expectError(cancelOffer(uw, uwBad, o), "WrongMint");
      const otherToken = await tokenAccount(Keypair.generate().publicKey, m(1_000));
      await expectError(acceptOffer(market, homeowner, otherToken, o), "WrongTokenOwner");
      await expectError(cancelOffer(uw, otherToken, o), "WrongTokenOwner");
    });
  });

  // =====================================================================
  describe("Lifecycle", () => {
    it("Only controller closes; only oracle resolves; resolve before close rejected; second resolve rejected", async () => {
      const { market } = await simpleMarket();
      const stranger = await newUser();

      await expectError(resolveMarket(market, true), "InvalidMarketStatus"); // before close
      await expectError(closeMarket(market, stranger), "Unauthorized");
      await expectError(closeMarket(market, oracle), "Unauthorized");
      await closeMarket(market);
      let mk = await program.account.market.fetch(market);
      expect(mk.status).to.deep.equal({ closed: {} });
      expect(mk.closedAt.toNumber()).to.be.greaterThan(0);
      await expectError(closeMarket(market), "InvalidMarketStatus"); // close twice

      await expectError(resolveMarket(market, true, stranger), "Unauthorized");
      await expectError(resolveMarket(market, true, controller), "Unauthorized");
      const hash = Array.from({ length: 32 }, (_, i) => 255 - i);
      await resolveMarket(market, true, oracle, hash);
      mk = await program.account.market.fetch(market);
      expect(mk.status).to.deep.equal({ resolvedYes: {} });
      expect(mk.evidenceHash).to.deep.equal(hash);
      expect(mk.resolvedAt.toNumber()).to.be.greaterThan(0);

      await expectError(resolveMarket(market, false), "InvalidMarketStatus"); // second resolve
      mk = await program.account.market.fetch(market);
      expect(mk.status).to.deep.equal({ resolvedYes: {} });
      expect(mk.evidenceHash).to.deep.equal(hash);
    });

    it("resolve(false) sets ResolvedNo", async () => {
      const { market } = await simpleMarket();
      await closeMarket(market);
      await resolveMarket(market, false);
      expect((await program.account.market.fetch(market)).status).to.deep.equal({ resolvedNo: {} });
    });

    it("Unaccepted offers can be cancelled in Closed, resolved, and Voided markets", async () => {
      const setups: Array<(mk: PublicKey) => Promise<void>> = [
        async () => {}, // Open
        async (mk) => {
          await closeMarket(mk);
        },
        async (mk) => {
          await closeMarket(mk);
          await resolveMarket(mk, true);
        },
        async (mk) => {
          await closeMarket(mk);
          await resolveMarket(mk, false);
        },
        async (mk) => {
          await voidMarket(mk);
        },
      ];
      for (const setup of setups) {
        const { market, uw, uwToken } = await simpleMarket();
        const before = await balance(uwToken);
        const o = await placeOffer(market, uw, uwToken, m(100), 400);
        await setup(market);
        const lamportsBefore = await conn.getBalance(uw.publicKey);
        const vaultRent = (await conn.getAccountInfo(o.vault))!.lamports;
        await cancelOffer(uw, uwToken, o);
        expect(await balance(uwToken)).to.equal(before);
        expect(await exists(o.vault)).to.equal(false);
        // Fee payer is the provider wallet, so the underwriter gains exactly the vault rent.
        expect((await conn.getBalance(uw.publicKey)) - lamportsBefore).to.equal(vaultRent);
        const off = await program.account.offer.fetch(o.offer);
        expect(off.status).to.deep.equal({ cancelled: {} });
      }
    });

    it("Only the offer's underwriter can cancel it", async () => {
      const { market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      const attacker = await newUser();
      const attackerToken = await tokenAccount(attacker.publicKey);
      await expectError(cancelOffer(attacker, attackerToken, o), "Unauthorized");
      expect(await balance(attackerToken)).to.equal(0n);
    });
  });

  // =====================================================================
  describe("Settlement", () => {
    async function participantsAndVaults(f: Fixture): Promise<PublicKey[]> {
      return [f.hoToken, ...f.uwTokens, ...f.offers.map((o) => o.vault)];
    }

    it("§4.3 worked example: offer terms match the table", async () => {
      const f = await workedExample(false);
      for (let i = 0; i < WORKED.length; i++) {
        const off = await program.account.offer.fetch(f.offers[i].offer);
        expect(off.premium.toString()).to.equal(WORKED[i].premium.toString());
        expect(off.collateral.toString()).to.equal(WORKED[i].collateral.toString());
        expect(await balance(f.offers[i].vault)).to.equal(WORKED[i].collateral);
      }
    });

    it("YES pays the homeowner exactly C per position; underwriter claim rejected; balances conserved", async () => {
      const homeowner = await newUser();
      const hoToken = await tokenAccount(homeowner.publicKey, m(1_000));
      const supplyBefore = (await getMint(conn, mint)).supply;

      const market = await createMarket(homeowner, m(10_000));
      const uws: Keypair[] = [];
      const uwTokens: PublicKey[] = [];
      for (let i = 0; i < 3; i++) {
        const uw = await newUser();
        uws.push(uw);
        uwTokens.push(await tokenAccount(uw.publicKey, m(10_000)));
      }
      const supplyFunded = (await getMint(conn, mint)).supply;
      const startTotal = await sumBalances([hoToken, ...uwTokens]);

      const offers: OfferRef[] = [];
      for (let i = 0; i < 3; i++) {
        offers.push(await placeOffer(market, uws[i], uwTokens[i], WORKED[i].coverage, WORKED[i].bps));
      }
      const f: Fixture = { homeowner, hoToken, market, uws, uwTokens, offers };
      const tracked = await participantsAndVaults(f);
      expect(await sumBalances(tracked)).to.equal(startTotal);

      for (const o of offers) await acceptOffer(market, homeowner, hoToken, o);
      expect(await sumBalances(tracked)).to.equal(startTotal);
      expect(await balance(hoToken)).to.equal(m(1_000) - m(445));
      const mk = await program.account.market.fetch(market);
      expect(mk.coverageActivated.toString()).to.equal(m(10_000).toString());
      expect(mk.acceptedCount).to.equal(3);

      await closeMarket(market);
      await resolveMarket(market, true);
      expect(await sumBalances(tracked)).to.equal(startTotal);

      for (let i = 0; i < 3; i++) {
        await expectError(
          claimPayout(market, uws[i], uwTokens[i], offers[i], uws[i].publicKey),
          "NotWinner",
        );
      }

      for (let i = 0; i < 3; i++) {
        const hoBefore = await balance(hoToken);
        const uwLamports = await conn.getBalance(uws[i].publicKey);
        const vaultRent = (await conn.getAccountInfo(offers[i].vault))!.lamports;
        await claimPayout(market, homeowner, hoToken, offers[i], uws[i].publicKey);
        expect((await balance(hoToken)) - hoBefore).to.equal(WORKED[i].coverage);
        expect(await exists(offers[i].vault)).to.equal(false);
        expect((await conn.getBalance(uws[i].publicKey)) - uwLamports).to.equal(vaultRent);
        const off = await program.account.offer.fetch(offers[i].offer);
        expect(off.status).to.deep.equal({ claimed: {} });
      }

      // Homeowner: paid 445, received 10,000 → net +9,555. Underwriters lost their collateral.
      expect(await balance(hoToken)).to.equal(m(1_000) + m(9_555));
      for (let i = 0; i < 3; i++) {
        expect(await balance(uwTokens[i])).to.equal(m(10_000) - WORKED[i].collateral);
      }
      expect(await sumBalances(tracked)).to.equal(startTotal);
      // No instruction mints or burns mUSD.
      expect((await getMint(conn, mint)).supply).to.equal(supplyFunded);
      expect(supplyFunded - supplyBefore).to.equal(m(30_000));
    });

    it("NO pays the underwriter exactly C per position; homeowner claim rejected; balances conserved", async () => {
      const f = await workedExample(false);
      const tracked = await participantsAndVaults(f);
      const startTotal = m(1_000) + m(30_000);
      const supply = (await getMint(conn, mint)).supply;
      expect(await sumBalances(tracked)).to.equal(startTotal);

      for (const o of f.offers) await acceptOffer(f.market, f.homeowner, f.hoToken, o);
      expect(await sumBalances(tracked)).to.equal(startTotal);
      await closeMarket(f.market);
      await resolveMarket(f.market, false);

      for (let i = 0; i < 3; i++) {
        await expectError(
          claimPayout(f.market, f.homeowner, f.hoToken, f.offers[i], f.uws[i].publicKey),
          "NotWinner",
        );
      }
      for (let i = 0; i < 3; i++) {
        const before = await balance(f.uwTokens[i]);
        await claimPayout(f.market, f.uws[i], f.uwTokens[i], f.offers[i], f.uws[i].publicKey);
        expect((await balance(f.uwTokens[i])) - before).to.equal(WORKED[i].coverage);
        // Net: collateral returned plus the premium earned.
        expect(await balance(f.uwTokens[i])).to.equal(m(10_000) + WORKED[i].premium);
      }
      // Homeowner is out 445.
      expect(await balance(f.hoToken)).to.equal(m(1_000) - m(445));
      expect(await sumBalances(tracked)).to.equal(startTotal);
      expect((await getMint(conn, mint)).supply).to.equal(supply);
    });

    it("Double claim rejected", async () => {
      const f = await workedExample(true);
      await closeMarket(f.market);
      await resolveMarket(f.market, true);
      await claimPayout(f.market, f.homeowner, f.hoToken, f.offers[0], f.uws[0].publicKey);
      const bal = await balance(f.hoToken);
      // The vault was closed by the first claim; the second fails at account validation.
      await expectError(
        claimPayout(f.market, f.homeowner, f.hoToken, f.offers[0], f.uws[0].publicKey),
        "AccountNotInitialized",
      );
      expect(await balance(f.hoToken)).to.equal(bal);
    });

    it("Claim to a token account not owned by the signer rejected", async () => {
      const f = await workedExample(true);
      await closeMarket(f.market);
      await resolveMarket(f.market, true);
      const thief = Keypair.generate();
      const thiefToken = await tokenAccount(thief.publicKey);
      await expectError(
        claimPayout(f.market, f.homeowner, thiefToken, f.offers[0], f.uws[0].publicKey),
        "WrongTokenOwner",
      );
      // The underwriter's account (wrong owner for the YES winner) is rejected too.
      await expectError(
        claimPayout(f.market, f.homeowner, f.uwTokens[0], f.offers[0], f.uws[0].publicKey),
        "WrongTokenOwner",
      );
    });

    it("Wrong mint rejected on claim_payout", async () => {
      const f = await workedExample(true);
      await closeMarket(f.market);
      await resolveMarket(f.market, true);
      const bad = await tokenAccount(f.homeowner.publicKey, 0n, badMint);
      await expectError(
        claimPayout(f.market, f.homeowner, bad, f.offers[0], f.uws[0].publicKey),
        "WrongMint",
      );
    });

    it("Claim before resolution rejected (Open and Closed markets)", async () => {
      const f = await workedExample(true);
      await expectError(
        claimPayout(f.market, f.homeowner, f.hoToken, f.offers[0], f.uws[0].publicKey),
        "InvalidMarketStatus",
      );
      await closeMarket(f.market);
      await expectError(
        claimPayout(f.market, f.homeowner, f.hoToken, f.offers[0], f.uws[0].publicKey),
        "InvalidMarketStatus",
      );
    });

    it("Claim on an unaccepted offer in a resolved market rejected", async () => {
      const f = await workedExample(false);
      await closeMarket(f.market);
      await resolveMarket(f.market, false);
      await expectError(
        claimPayout(f.market, f.uws[0], f.uwTokens[0], f.offers[0], f.uws[0].publicKey),
        "InvalidOfferStatus",
      );
    });

    it("Claim with a rent destination other than the original underwriter rejected", async () => {
      const f = await workedExample(true);
      await closeMarket(f.market);
      await resolveMarket(f.market, true);
      await expectError(
        claimPayout(f.market, f.homeowner, f.hoToken, f.offers[0], f.homeowner.publicKey),
        "Unauthorized",
      );
    });
  });

  // =====================================================================
  describe("Void", () => {
    it("Only admin voids; resolved market cannot be voided; Open and Closed can", async () => {
      const stranger = await newUser();
      const open = await simpleMarket();
      await expectError(voidMarket(open.market, stranger), "Unauthorized");
      await expectError(voidMarket(open.market, controller), "Unauthorized");
      await voidMarket(open.market);
      expect((await program.account.market.fetch(open.market)).status).to.deep.equal({ voided: {} });
      await expectError(voidMarket(open.market), "InvalidMarketStatus"); // already voided
      await expectError(closeMarket(open.market), "InvalidMarketStatus");

      const closed = await simpleMarket();
      await closeMarket(closed.market);
      await voidMarket(closed.market);
      await expectError(resolveMarket(closed.market, true), "InvalidMarketStatus");

      for (const triggered of [true, false]) {
        const r = await simpleMarket();
        await closeMarket(r.market);
        await resolveMarket(r.market, triggered);
        await expectError(voidMarket(r.market), "InvalidMarketStatus");
      }
    });

    it("Refund returns P to homeowner and K to underwriter; double refund rejected", async () => {
      const f = await workedExample(true);
      const tracked = [f.hoToken, ...f.uwTokens, ...f.offers.map((o) => o.vault)];
      const total = await sumBalances(tracked);
      await closeMarket(f.market);
      await voidMarket(f.market);
      await expectError(
        claimPayout(f.market, f.homeowner, f.hoToken, f.offers[0], f.uws[0].publicKey),
        "InvalidMarketStatus",
      );

      for (let i = 0; i < 3; i++) {
        const hoBefore = await balance(f.hoToken);
        const uwBefore = await balance(f.uwTokens[i]);
        const uwLamports = await conn.getBalance(f.uws[i].publicKey);
        const vaultRent = (await conn.getAccountInfo(f.offers[i].vault))!.lamports;
        // Cranked by the provider wallet: anyone can refund.
        await refundOffer(f.market, f.offers[i], f.hoToken, f.uwTokens[i], f.uws[i].publicKey);
        expect((await balance(f.hoToken)) - hoBefore).to.equal(WORKED[i].premium);
        expect((await balance(f.uwTokens[i])) - uwBefore).to.equal(WORKED[i].collateral);
        expect(await exists(f.offers[i].vault)).to.equal(false);
        expect((await conn.getBalance(f.uws[i].publicKey)) - uwLamports).to.equal(vaultRent);
        expect((await program.account.offer.fetch(f.offers[i].offer)).status).to.deep.equal({
          refunded: {},
        });
      }
      // Everyone is back where they started.
      expect(await balance(f.hoToken)).to.equal(m(1_000));
      for (const t of f.uwTokens) expect(await balance(t)).to.equal(m(10_000));
      expect(await sumBalances(tracked)).to.equal(total);

      await expectError(
        refundOffer(f.market, f.offers[0], f.hoToken, f.uwTokens[0], f.uws[0].publicKey),
        "AccountNotInitialized",
      );
    });

    it("Refund rejected on a non-voided market, for an unaccepted offer, and with wrong accounts", async () => {
      const f = await workedExample(false);
      await acceptOffer(f.market, f.homeowner, f.hoToken, f.offers[0]);
      // Not voided.
      await expectError(
        refundOffer(f.market, f.offers[0], f.hoToken, f.uwTokens[0], f.uws[0].publicKey),
        "InvalidMarketStatus",
      );
      await voidMarket(f.market);
      // Offer still Open (not accepted): use cancel_offer instead.
      await expectError(
        refundOffer(f.market, f.offers[1], f.hoToken, f.uwTokens[1], f.uws[1].publicKey),
        "InvalidOfferStatus",
      );
      // Wrong mint on either destination.
      const hoBad = await tokenAccount(f.homeowner.publicKey, 0n, badMint);
      const uwBad = await tokenAccount(f.uws[0].publicKey, 0n, badMint);
      await expectError(
        refundOffer(f.market, f.offers[0], hoBad, f.uwTokens[0], f.uws[0].publicKey),
        "WrongMint",
      );
      await expectError(
        refundOffer(f.market, f.offers[0], f.hoToken, uwBad, f.uws[0].publicKey),
        "WrongMint",
      );
      // Wrong owner on either destination.
      const stranger = await tokenAccount(Keypair.generate().publicKey);
      await expectError(
        refundOffer(f.market, f.offers[0], stranger, f.uwTokens[0], f.uws[0].publicKey),
        "WrongTokenOwner",
      );
      await expectError(
        refundOffer(f.market, f.offers[0], f.hoToken, stranger, f.uws[0].publicKey),
        "WrongTokenOwner",
      );
      // Then the correct refund works.
      await refundOffer(f.market, f.offers[0], f.hoToken, f.uwTokens[0], f.uws[0].publicKey);
    });
  });

  // =====================================================================
  describe("Security invariants (§6.3)", () => {
    it("inv-1: only the oracle resolves, only the controller closes, only the admin registers and voids", async () => {
      const stranger = await newUser();
      const { market } = await simpleMarket();
      for (const s of [stranger, oracle]) await expectError(closeMarket(market, s), "Unauthorized");
      await closeMarket(market, controller);
      for (const s of [stranger, controller]) {
        await expectError(resolveMarket(market, true, s), "Unauthorized");
      }
      await resolveMarket(market, true, oracle);
      for (const s of [stranger, oracle, controller]) {
        await expectError(registerProperty(300, 0, 0, PROP_TRIGGER, s), "Unauthorized");
      }
      const other = await simpleMarket();
      for (const s of [stranger, oracle, controller]) {
        await expectError(voidMarket(other.market, s), "Unauthorized");
      }
    });

    it("inv-2: no instruction takes an oracle, controller or mint as a caller-supplied value; a fake Config is rejected", async () => {
      // Only initialize_config takes Pubkey arguments (and only there are they stored).
      for (const ix of program.idl.instructions) {
        const pubkeyArgs = ix.args.filter((a) => JSON.stringify(a.type) === '"pubkey"');
        if (ix.name === "initializeConfig") {
          expect(pubkeyArgs.map((a) => a.name)).to.deep.equal(["oracle", "controller"]);
        } else {
          expect(pubkeyArgs, `${ix.name} pubkey args`).to.have.length(0);
        }
      }
      // Substituting another account for Config fails the PDA/ownership checks.
      const { market } = await simpleMarket();
      const fakeConfig = await tokenAccount(controller.publicKey); // some non-Config account
      await expectError(
        program.methods
          .closeMarket()
          .accountsPartial({ demoController: controller.publicKey, config: fakeConfig, market })
          .signers([controller])
          .rpc(),
        "AccountOwnedByWrongProgram",
      );
    });

    it("inv-3: market coordinates come only from a registered Property", async () => {
      const createIx = program.idl.instructions.find((i) => i.name === "createMarket")!;
      expect(createIx.args.map((a) => a.name)).to.deep.equal([
        "marketNonce",
        "propertyId",
        "coverageTarget",
      ]);
      await registerProperty(301, -45_000_000, 170_000_000, 750);
      const homeowner = await newUser();
      const market = await createMarket(homeowner, m(100), 301);
      const mk = await program.account.market.fetch(market);
      expect([mk.latE6, mk.lonE6, mk.triggerDistanceM, mk.propertyId]).to.deep.equal([
        -45_000_000, 170_000_000, 750, 301,
      ]);
      // Passing property 301 while naming property_id 1 fails the seeds check.
      const nonce = marketNonce++;
      await expectError(
        program.methods
          .createMarket(bn(nonce), PROP_ID, bn(m(100)))
          .accountsPartial({
            homeowner: homeowner.publicKey,
            property: findPropertyPda(pid, 301)[0],
            market: findMarketPda(pid, homeowner.publicKey, nonce)[0],
          })
          .signers([homeowner])
          .rpc(),
        "ConstraintSeeds",
      );
    });

    it("inv-4: only the homeowner accepts; only the offer's underwriter cancels", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      const stranger = await newUser();
      const strangerToken = await tokenAccount(stranger.publicKey, m(1_000));
      await expectError(acceptOffer(market, stranger, strangerToken, o), "Unauthorized");
      await expectError(cancelOffer(stranger, strangerToken, o), "Unauthorized");
      await expectError(cancelOffer(homeowner, hoToken, o), "Unauthorized");
      await cancelOffer(uw, uwToken, o);
    });

    it("inv-5: underwriter cannot be the market's homeowner", async () => {
      const { homeowner, hoToken, market } = await simpleMarket();
      await expectError(
        placeOfferTx(market, homeowner, hoToken, m(100), 400).builder.rpc(),
        "SelfUnderwriting",
      );
    });

    it("inv-6: accepted offers cannot be cancelled (in any market status)", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      await acceptOffer(market, homeowner, hoToken, o);
      await expectError(cancelOffer(uw, uwToken, o), "InvalidOfferStatus");
      await closeMarket(market);
      await expectError(cancelOffer(uw, uwToken, o), "InvalidOfferStatus");
      await resolveMarket(market, false);
      await expectError(cancelOffer(uw, uwToken, o), "InvalidOfferStatus");
      expect(await balance(o.vault)).to.equal(m(100));
    });

    it("inv-7: coverage_activated never exceeds coverage_target", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket(m(100));
      const offers: OfferRef[] = [];
      for (const c of [30, 30, 30, 30, 10]) offers.push(await placeOffer(market, uw, uwToken, m(c), 400));
      for (const o of offers) {
        const mkBefore = await program.account.market.fetch(market);
        const off = await program.account.offer.fetch(o.offer);
        const wouldBe = BigInt(mkBefore.coverageActivated.toString()) + BigInt(off.coverage.toString());
        if (wouldBe > m(100)) {
          await expectError(acceptOffer(market, homeowner, hoToken, o), "CoverageExceedsRemaining");
        } else {
          await acceptOffer(market, homeowner, hoToken, o);
        }
        const mk = await program.account.market.fetch(market);
        expect(BigInt(mk.coverageActivated.toString()) <= m(100)).to.equal(true);
      }
      const mk = await program.account.market.fetch(market);
      expect(mk.coverageActivated.toString()).to.equal(m(100).toString());
      expect(mk.acceptedCount).to.equal(4);
    });

    it("inv-8: premium + collateral == coverage for every offer (incl. rounding edges)", async () => {
      const { market, uw, uwToken } = await simpleMarket(m(10_000));
      const cases: Array<[bigint, number]> = [
        [MIN_COVERAGE, 1],
        [MIN_COVERAGE + 1n, 9_999],
        [m(1_234) + 5_678n, 777],
        [m(9_999) + 999_999n, 3],
        [m(10_000), 9_999],
      ];
      // The cases together lock more than simpleMarket's 10,000 mUSD of collateral.
      await mintTo(conn, payer, mint, uwToken, payer, m(50_000), [], CONFIRMED);
      for (const [c, b] of cases) {
        const o = await placeOffer(market, uw, uwToken, c, b);
        const off = await program.account.offer.fetch(o.offer);
        const p = BigInt(off.premium.toString());
        const k = BigInt(off.collateral.toString());
        expect(p + k).to.equal(c);
        expect(p).to.equal((c * BigInt(b)) / 10_000n);
        expect({ p, k }).to.deep.equal({
          p: computeOfferTerms(c, b).premium,
          k: computeOfferTerms(c, b).collateral,
        });
        expect(await balance(o.vault)).to.equal(k);
      }
    });

    it("inv-9: a market resolves at most once; final states are immutable", async () => {
      for (const triggered of [true, false]) {
        const { market } = await simpleMarket();
        await closeMarket(market);
        await resolveMarket(market, triggered);
        const before = await program.account.market.fetch(market);
        await expectError(resolveMarket(market, !triggered), "InvalidMarketStatus");
        await expectError(resolveMarket(market, triggered), "InvalidMarketStatus");
        await expectError(closeMarket(market), "InvalidMarketStatus");
        await expectError(voidMarket(market), "InvalidMarketStatus");
        const after = await program.account.market.fetch(market);
        expect(after.status).to.deep.equal(before.status);
        expect(after.evidenceHash).to.deep.equal(before.evidenceHash);
        expect(after.resolvedAt.toString()).to.equal(before.resolvedAt.toString());
      }
      const { market } = await simpleMarket();
      await voidMarket(market);
      await expectError(closeMarket(market), "InvalidMarketStatus");
      await expectError(resolveMarket(market, true), "InvalidMarketStatus");
      await expectError(voidMarket(market), "InvalidMarketStatus");
    });

    it("inv-10: each offer pays out at most once (Claimed / Refunded / Cancelled are terminal)", async () => {
      // Claimed
      const f = await workedExample(true);
      await closeMarket(f.market);
      await resolveMarket(f.market, false);
      await claimPayout(f.market, f.uws[0], f.uwTokens[0], f.offers[0], f.uws[0].publicKey);
      await expectError(
        claimPayout(f.market, f.uws[0], f.uwTokens[0], f.offers[0], f.uws[0].publicKey),
        "AccountNotInitialized",
      );
      // Refunded
      const g = await workedExample(true);
      await voidMarket(g.market);
      await refundOffer(g.market, g.offers[0], g.hoToken, g.uwTokens[0], g.uws[0].publicKey);
      await expectError(
        refundOffer(g.market, g.offers[0], g.hoToken, g.uwTokens[0], g.uws[0].publicKey),
        "AccountNotInitialized",
      );
      // Cancelled
      const { market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      await cancelOffer(uw, uwToken, o);
      const bal = await balance(uwToken);
      await expectError(cancelOffer(uw, uwToken, o), "AccountNotInitialized");
      expect(await balance(uwToken)).to.equal(bal);
      // Terminal status persists on the Offer account.
      expect((await program.account.offer.fetch(f.offers[0].offer)).status).to.deep.equal({ claimed: {} });
      expect((await program.account.offer.fetch(g.offers[0].offer)).status).to.deep.equal({ refunded: {} });
      expect((await program.account.offer.fetch(o.offer)).status).to.deep.equal({ cancelled: {} });
    });

    it("inv-11: only the winning side can claim", async () => {
      const yes = await workedExample(true);
      await closeMarket(yes.market);
      await resolveMarket(yes.market, true);
      const stranger = await newUser();
      const strangerToken = await tokenAccount(stranger.publicKey);
      await expectError(
        claimPayout(yes.market, yes.uws[0], yes.uwTokens[0], yes.offers[0], yes.uws[0].publicKey),
        "NotWinner",
      );
      await expectError(
        claimPayout(yes.market, stranger, strangerToken, yes.offers[0], yes.uws[0].publicKey),
        "NotWinner",
      );
      await claimPayout(yes.market, yes.homeowner, yes.hoToken, yes.offers[0], yes.uws[0].publicKey);

      const no = await workedExample(true);
      await closeMarket(no.market);
      await resolveMarket(no.market, false);
      await expectError(
        claimPayout(no.market, no.homeowner, no.hoToken, no.offers[0], no.uws[0].publicKey),
        "NotWinner",
      );
      await expectError(
        claimPayout(no.market, stranger, strangerToken, no.offers[0], no.uws[0].publicKey),
        "NotWinner",
      );
      // A different underwriter in the same market cannot claim this offer.
      await expectError(
        claimPayout(no.market, no.uws[1], no.uwTokens[1], no.offers[0], no.uws[0].publicKey),
        "NotWinner",
      );
      await claimPayout(no.market, no.uws[0], no.uwTokens[0], no.offers[0], no.uws[0].publicKey);
      expect(await balance(strangerToken)).to.equal(0n);
    });

    it("inv-12: every token account's mint equals config.mint (place, cancel, accept, claim, refund)", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const uwBad = await tokenAccount(uw.publicKey, m(10_000), badMint);
      const hoBad = await tokenAccount(homeowner.publicKey, m(10_000), badMint);
      // place_offer: wrong mint account, wrong underwriter token account
      await expectError(placeOfferTx(market, uw, uwToken, m(100), 400, badMint).builder.rpc(), "WrongMint");
      await expectError(placeOfferTx(market, uw, uwBad, m(100), 400).builder.rpc(), "WrongMint");
      const o1 = await placeOffer(market, uw, uwToken, m(100), 400);
      const o2 = await placeOffer(market, uw, uwToken, m(100), 400);
      const o3 = await placeOffer(market, uw, uwToken, m(100), 400);
      // cancel_offer
      await expectError(cancelOffer(uw, uwBad, o1), "WrongMint");
      // accept_offer
      await expectError(acceptOffer(market, homeowner, hoBad, o2), "WrongMint");
      await acceptOffer(market, homeowner, hoToken, o2);
      await acceptOffer(market, homeowner, hoToken, o3);
      // Vaults use config.mint.
      expect((await getAccount(conn, o2.vault)).mint.toBase58()).to.equal(mint.toBase58());
      await closeMarket(market);
      // refund_offer (needs a voided market) — use a second market below.
      await resolveMarket(market, true);
      // claim_payout
      await expectError(claimPayout(market, homeowner, hoBad, o2, uw.publicKey), "WrongMint");
      await claimPayout(market, homeowner, hoToken, o2, uw.publicKey);

      const v = await workedExample(true);
      await voidMarket(v.market);
      const vHoBad = await tokenAccount(v.homeowner.publicKey, 0n, badMint);
      const vUwBad = await tokenAccount(v.uws[0].publicKey, 0n, badMint);
      await expectError(
        refundOffer(v.market, v.offers[0], vHoBad, v.uwTokens[0], v.uws[0].publicKey),
        "WrongMint",
      );
      await expectError(
        refundOffer(v.market, v.offers[0], v.hoToken, vUwBad, v.uws[0].publicKey),
        "WrongMint",
      );
    });

    it("inv-13: arithmetic is checked at the bounds and vault funds move only via the Offer PDA", async () => {
      // Largest possible offer: C = MAX_COVERAGE_TARGET, b = 9,999 (u128 intermediate).
      const homeowner = await newUser();
      const { premium, collateral } = computeOfferTerms(MAX_COVERAGE_TARGET, 9_999);
      const hoToken = await tokenAccount(homeowner.publicKey, premium);
      const market = await createMarket(homeowner, MAX_COVERAGE_TARGET);
      const uw = await newUser();
      const uwToken = await tokenAccount(uw.publicKey, collateral);
      const o = await placeOffer(market, uw, uwToken, MAX_COVERAGE_TARGET, 9_999);
      const off = await program.account.offer.fetch(o.offer);
      expect(BigInt(off.premium.toString())).to.equal(premium);
      expect(BigInt(off.collateral.toString())).to.equal(collateral);
      await acceptOffer(market, homeowner, hoToken, o);
      expect(await balance(o.vault)).to.equal(MAX_COVERAGE_TARGET);
      expect((await program.account.market.fetch(market)).coverageActivated.toString()).to.equal(
        MAX_COVERAGE_TARGET.toString(),
      );

      // The vault's token authority is the Offer PDA; no wallet can move vault funds directly.
      const vault = await getAccount(conn, o.vault);
      expect(vault.owner.toBase58()).to.equal(o.offer.toBase58());
      for (const signer of [uw, homeowner, payer]) {
        await expectFailureContaining(
          transfer(conn, payer, o.vault, uwToken, signer, 1n),
          "owner does not match",
        );
      }
      expect(await balance(o.vault)).to.equal(MAX_COVERAGE_TARGET);
    });

    it("inv-14: claims go only to the current holder of the winning side", async () => {
      const { homeowner, hoToken, market, uw, uwToken } = await simpleMarket();
      const o = await placeOffer(market, uw, uwToken, m(100), 400);
      let off = await program.account.offer.fetch(o.offer);
      expect(off.protectionHolder.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(off.riskHolder.toBase58()).to.equal(PublicKey.default.toBase58());
      await acceptOffer(market, homeowner, hoToken, o);
      off = await program.account.offer.fetch(o.offer);
      expect(off.protectionHolder.toBase58()).to.equal(homeowner.publicKey.toBase58());
      expect(off.riskHolder.toBase58()).to.equal(uw.publicKey.toBase58());

      await closeMarket(market);
      await resolveMarket(market, true);
      // The default key (pre-acceptance holder value) can never sign, and non-holders fail.
      await expectError(claimPayout(market, uw, uwToken, o, uw.publicKey), "NotWinner");
      const before = await balance(hoToken);
      await claimPayout(market, homeowner, hoToken, o, uw.publicKey);
      expect((await balance(hoToken)) - before).to.equal(m(100));
    });
  });

  it("uses the classic SPL Token program for every token-moving instruction", () => {
    const names = ["placeOffer", "cancelOffer", "acceptOffer", "claimPayout", "refundOffer"];
    for (const name of names) {
      const ix = program.idl.instructions.find((i) => i.name === name)!;
      const tp = ix.accounts.find((a) => a.name === "tokenProgram") as { address?: string };
      expect(tp.address, name).to.equal(TOKEN_PROGRAM_ID.toBase58());
    }
  });
});
