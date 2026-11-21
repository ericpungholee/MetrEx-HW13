// setup-devnet.ts (spec §9.4): create the mUSD mint, initialize Config, register properties.
// Idempotent: every step reads chain state first and skips what already exists.
//   pnpm tsx scripts/setup-devnet.ts [--dry-run]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createMint, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { encodeLabel, findPropertyPda, MUSD_DECIMALS, type ScenarioRegistry } from "@metrex/shared";
import {
  configPda,
  envOrUndefined,
  explorerAddress,
  getProgram,
  getRpc,
  getSolLamports,
  initializeConfigIx,
  loadKeypair,
  musdMintFile,
  programDataAddress,
  readMintFile,
  registerPropertyIx,
  sendTx,
  solToLamports,
} from "@metrex/server";
import {
  banner,
  DRY_RUN,
  exitWith,
  log,
  propertiesPath,
  readJsonIfExists,
  scenariosPath,
  sol,
  validateProperties,
} from "./lib/common";

/** Parses an upgradeable-loader ProgramData account: [u32 tag=3][u64 slot][Option<Pubkey>]. */
function upgradeAuthorityOf(data: Uint8Array): PublicKey | null | "invalid" {
  if (data.length < 13) return "invalid";
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 3) return "invalid";
  if (data[12] === 0) return null;
  return new PublicKey(data.subarray(13, 45));
}

async function main(): Promise<void> {
  banner("setup-devnet");
  let problems = 0;
  const conn = getRpc().connection;
  const program = getProgram(conn);
  const pid = program.programId;

  const admin = loadKeypair("admin");
  const mintAuthority = loadKeypair("mintAuthority").publicKey;
  const oracle = loadKeypair("oracle").publicKey;
  const controller = loadKeypair("controller").publicKey;
  console.log(`  admin   ${admin.publicKey.toBase58()}`);
  console.log(`  oracle  ${oracle.toBase58()}`);
  console.log(`  control ${controller.toBase58()}`);
  console.log(`  mintAuth ${mintAuthority.toBase58()}`);

  const adminSol = await getSolLamports(conn, admin.publicKey);
  console.log(`  admin balance ${sol(adminSol)}`);
  if (adminSol < solToLamports("0.05")) log.warn("admin has < 0.05 SOL; transactions below will fail");

  // ---------- 1. mUSD mint ----------
  log.step("mUSD mint (6 decimals, authority = mint-authority, no freeze authority)");
  const envMint = envOrUndefined("MUSD_MINT");
  const fileMint = readMintFile();
  if (envMint && fileMint && envMint !== fileMint.toBase58()) {
    log.warn(`MUSD_MINT ${envMint} differs from ${musdMintFile()} (${fileMint.toBase58()}); using MUSD_MINT`);
  }
  let mint: PublicKey | undefined = envMint ? new PublicKey(envMint) : fileMint;
  if (mint) {
    const info = await conn.getAccountInfo(mint);
    if (!info) {
      log.fail(`mint ${mint.toBase58()} (from ${envMint ? "MUSD_MINT" : musdMintFile()}) does not exist on this cluster.`);
      log.fail("Remove the stale value/file to create a new mint, or point RPC_URL at the right cluster.");
      exitWith(1);
    }
    const m = await getMint(conn, mint, "confirmed", TOKEN_PROGRAM_ID);
    if (m.decimals !== MUSD_DECIMALS) {
      log.fail(`mint has ${m.decimals} decimals, expected ${MUSD_DECIMALS}`);
      problems++;
    }
    if (!m.mintAuthority?.equals(mintAuthority)) {
      log.fail(`mint authority is ${m.mintAuthority?.toBase58() ?? "none"}, expected mint-authority`);
      problems++;
    }
    if (m.freezeAuthority) log.warn(`mint has a freeze authority ${m.freezeAuthority.toBase58()}`);
    log.ok(`exists: ${mint.toBase58()}`);
  } else if (DRY_RUN) {
    log.todo("create a new mUSD mint and save it to " + musdMintFile());
  } else {
    const mintKp = Keypair.generate();
    mint = await createMint(conn, admin, mintAuthority, null, MUSD_DECIMALS, mintKp, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    mkdirSync(dirname(musdMintFile()), { recursive: true });
    writeFileSync(musdMintFile(), JSON.stringify({ mint: mint.toBase58() }, null, 2) + "\n");
    log.ok(`created ${mint.toBase58()} (saved to ${musdMintFile()})`);
  }
  if (mint) log.addr("mint", mint);

  // ---------- 2. Program + upgrade authority ----------
  log.step("program deployment and upgrade authority (initialize_config requires admin = upgrade authority)");
  const progInfo = await conn.getAccountInfo(pid);
  let canInit = true;
  if (!progInfo || !progInfo.executable) {
    log.fail(`program ${pid.toBase58()} is not deployed on this cluster. Deploy it first (anchor deploy --provider.cluster devnet).`);
    problems++;
    canInit = false;
  } else {
    const pd = programDataAddress(pid);
    const pdInfo = await conn.getAccountInfo(pd);
    const auth = pdInfo ? upgradeAuthorityOf(pdInfo.data) : "invalid";
    if (auth === "invalid") {
      log.fail("program is not owned by the upgradeable loader / ProgramData unreadable");
      problems++;
      canInit = false;
    } else if (auth === null) {
      log.fail("program is immutable (no upgrade authority); initialize_config can never succeed. Redeploy.");
      problems++;
      canInit = false;
    } else if (!auth.equals(admin.publicKey)) {
      log.fail(`upgrade authority is ${auth.toBase58()}, but admin is ${admin.publicKey.toBase58()}.`);
      console.log(
        "        initialize_config checks ProgramData.upgrade_authority == admin (spec §6, v1.1.1).\n" +
          "        Either deploy with the admin keypair as upgrade authority, or transfer it:\n" +
          `          solana program set-upgrade-authority ${pid.toBase58()} \\\n` +
          "            --new-upgrade-authority ~/.config/metrex/admin.json \\\n" +
          "            --keypair <current-upgrade-authority.json> --url devnet\n" +
          "        then re-run this script.",
      );
      problems++;
      canInit = false;
    } else {
      log.ok(`deployed; upgrade authority = admin`);
    }
  }

  // ---------- 3. Config ----------
  log.step("Config");
  const cfgPk = configPda(program);
  const cfg = progInfo ? await program.account.config.fetchNullable(cfgPk) : null;
  if (cfg) {
    const checks: [string, PublicKey, PublicKey | undefined][] = [
      ["admin", cfg.admin, admin.publicKey],
      ["oracle_authority", cfg.oracleAuthority, oracle],
      ["demo_controller", cfg.demoController, controller],
      ["mint", cfg.mint, mint],
    ];
    for (const [name, onChain, want] of checks) {
      if (want && !onChain.equals(want)) {
        log.fail(`config.${name} = ${onChain.toBase58()}, local key is ${want.toBase58()} (no update instruction; redeploy to rotate)`);
        problems++;
      }
    }
    log.ok(`exists: ${cfgPk.toBase58()}`);
  } else if (oracle.equals(controller)) {
    log.fail("oracle and controller keys must differ (spec §2)");
    problems++;
  } else if (!canInit || !mint) {
    log.warn("skipped: program/mint not ready");
  } else if (DRY_RUN) {
    log.todo(`initialize_config(oracle=${oracle.toBase58()}, controller=${controller.toBase58()})`);
  } else {
    const ix = await initializeConfigIx(program, { admin: admin.publicKey, oracle, controller, mint });
    log.tx("initialize_config", await sendTx(conn, [ix], [admin]));
  }
  log.addr("config", cfgPk);

  // ---------- 4. Properties ----------
  log.step("properties (data/properties.json)");
  const registry = readJsonIfExists<ScenarioRegistry>(scenariosPath());
  const raw = readJsonIfExists<unknown>(propertiesPath());
  if (!registry) log.warn("data/scenarios.json missing (Workstream B); scenario IDs not cross-checked");
  if (raw === undefined) {
    log.fail(`${propertiesPath()} not found (Workstream B produces it with scripts/find-properties.ts)`);
    problems++;
  } else {
    const { rows, errors } = validateProperties(raw, registry);
    for (const e of errors) log.fail(e);
    problems += errors.length;
    for (const id of [1, 2, 3]) if (!rows.some((r) => r.property_id === id)) log.warn(`property ${id} missing (spec §8.3)`);
    const configReady = cfg !== null || (!DRY_RUN && canInit && !!mint);
    for (const r of rows) {
      const pda = findPropertyPda(pid, r.property_id)[0];
      const existing = progInfo ? await program.account.property.fetchNullable(pda) : null;
      const label = encodeLabel(r.label);
      if (existing) {
        const same =
          existing.latE6 === r.lat_e6 &&
          existing.lonE6 === r.lon_e6 &&
          existing.scenarioId === r.scenario_id &&
          existing.triggerDistanceM === r.trigger_distance_m &&
          existing.label.every((b, i) => b === label[i]);
        if (same) log.ok(`property ${r.property_id} "${r.label}" registered`);
        else {
          log.fail(`property ${r.property_id} is registered with different data (properties cannot be changed)`);
          problems++;
        }
      } else if (!configReady) {
        log.warn(`property ${r.property_id}: skipped until Config exists`);
      } else if (DRY_RUN) {
        log.todo(`register_property(${r.property_id}, "${r.label}", ${r.lat_e6}, ${r.lon_e6}, ${r.scenario_id}, ${r.trigger_distance_m})`);
      } else {
        const ix = await registerPropertyIx(program, admin.publicKey, {
          propertyId: r.property_id,
          label,
          latE6: r.lat_e6,
          lonE6: r.lon_e6,
          scenarioId: r.scenario_id,
          triggerDistanceM: r.trigger_distance_m,
        });
        log.tx(`register_property ${r.property_id}`, await sendTx(conn, [ix], [admin]));
      }
      console.log(`        ${explorerAddress(pda)}`);
    }
  }

  if (mint) {
    log.step("env values");
    console.log(`  PROGRAM_ID=${pid.toBase58()}\n  MUSD_MINT=${mint.toBase58()}`);
    console.log(`  NEXT_PUBLIC_PROGRAM_ID=${pid.toBase58()}\n  NEXT_PUBLIC_MUSD_MINT=${mint.toBase58()}`);
  }
  exitWith(problems);
}

main().catch((e: unknown) => {
  console.error(`setup-devnet failed: ${(e as Error).message}`);
  process.exit(1);
});
