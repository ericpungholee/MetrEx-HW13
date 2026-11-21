// setup-devnet-v2.ts (spec-v2 §6.1, §14): initialize the v2 Config with the existing mUSD mint and
// register the three dataset properties. Idempotent: every step reads chain state first.
//   pnpm tsx scripts/setup-devnet-v2.ts [--dry-run]
//   pnpm tsx scripts/setup-devnet-v2.ts --local [--timeout 120] [--create-mint]   (loopback validator only)
// Devnet refuses a resolution timeout below 86,400 s (§6.1). Only --local may create a mint.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createMint, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEVNET_MIN_RESOLUTION_TIMEOUT_S, MAX_RESOLUTION_TIMEOUT_S, MIN_RESOLUTION_TIMEOUT_S, MUSD_DECIMALS } from "@metrex/exchange";
import { encodeLabel, type ScenarioRegistry } from "@metrex/shared";
import {
  envOrUndefined,
  exchangeConfigPda,
  exchangeProgramId,
  fetchExchangeConfig,
  fetchProperty,
  getExchangeProgram,
  getRpc,
  getSolLamports,
  initializeExchangeConfigIx,
  loadKeypair,
  programDataOf,
  registerExchangePropertyIx,
  sendExchangeTx,
  solToLamports,
} from "@metrex/server/exchange";
import { musdMintFile, readMintFile } from "@metrex/server";
import { DEVNET_GENESIS, isLoopback, upgradeAuthorityOf } from "./lib/v2";
import { args, DRY_RUN, exitWith, flagValue, log, propertiesPath, readJsonIfExists, scenariosPath, sol, validateProperties } from "./lib/common";

const LOCAL = args.includes("--local");

async function main(): Promise<void> {
  const conn = getRpc().connection;
  console.log(`setup-devnet-v2${DRY_RUN ? " (dry run)" : ""}${LOCAL ? " (local validator)" : ""}`);
  console.log(`  program ${exchangeProgramId().toBase58()}`);
  if (LOCAL) {
    if (!isLoopback(conn.rpcEndpoint)) throw new Error("--local requires a loopback RPC_URL");
  } else if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) {
    throw new Error("RPC is not Solana Devnet (genesis hash mismatch). Use --local for a loopback validator.");
  }
  const timeout = Number(flagValue("--timeout") ?? (LOCAL ? 120 : DEVNET_MIN_RESOLUTION_TIMEOUT_S));
  if (!Number.isInteger(timeout) || timeout < MIN_RESOLUTION_TIMEOUT_S || timeout > MAX_RESOLUTION_TIMEOUT_S) {
    throw new Error(`--timeout must be within [${MIN_RESOLUTION_TIMEOUT_S}, ${MAX_RESOLUTION_TIMEOUT_S}]`);
  }
  if (!LOCAL && timeout < DEVNET_MIN_RESOLUTION_TIMEOUT_S) throw new Error(`Devnet refuses a resolution timeout below ${DEVNET_MIN_RESOLUTION_TIMEOUT_S} s (spec-v2 §6.1)`);

  let problems = 0;
  const p = getExchangeProgram(conn);
  const pid = p.programId;
  const admin = loadKeypair("admin");
  const oracle = loadKeypair("oracle").publicKey;
  const controller = loadKeypair("controller").publicKey;
  const mintAuthority = loadKeypair("mintAuthority");
  console.log(`  admin ${admin.publicKey.toBase58()}  balance ${sol(await getSolLamports(conn, admin.publicKey))}`);

  log.step("program and upgrade authority (initialize_config requires admin = upgrade authority)");
  const progInfo = await conn.getAccountInfo(pid);
  if (!progInfo?.executable) {
    log.fail(`v2 program ${pid.toBase58()} is not deployed on this cluster`);
    exitWith(1);
  }
  const pd = await conn.getAccountInfo(programDataOf(pid));
  const auth = pd ? upgradeAuthorityOf(pd.data) : "invalid";
  if (auth === "invalid" || auth === null || !auth.equals(admin.publicKey)) {
    log.fail(`upgrade authority is ${auth === "invalid" ? "unreadable" : auth === null ? "none" : auth.toBase58()}, admin is ${admin.publicKey.toBase58()}`);
    exitWith(1);
  }
  log.ok("deployed; upgrade authority = admin");

  log.step("collateral mint (the existing mUSD mint: 6 decimals, no freeze authority)");
  const envMint = envOrUndefined("MUSD_MINT");
  let mint = envMint ? new PublicKey(envMint) : readMintFile();
  if (mint && !(await conn.getAccountInfo(mint))) {
    log.fail(`mint ${mint.toBase58()} does not exist on this cluster`);
    exitWith(1);
  }
  if (!mint) {
    if (!LOCAL || !args.includes("--create-mint")) {
      log.fail("no mUSD mint found (MUSD_MINT or musd-mint.json). v2 reuses the existing Devnet mint (§14).");
      exitWith(1);
    }
    if (DRY_RUN) log.todo("create a local mUSD mint");
    else {
      mint = await createMint(conn, admin, mintAuthority.publicKey, null, MUSD_DECIMALS, Keypair.generate(), { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
      mkdirSync(dirname(musdMintFile()), { recursive: true });
      writeFileSync(musdMintFile(), JSON.stringify({ mint: mint.toBase58() }, null, 2) + "\n");
      log.ok(`created local mint ${mint.toBase58()} → ${musdMintFile()}`);
    }
  }
  if (mint) {
    const mi = await getMint(conn, mint, "confirmed", TOKEN_PROGRAM_ID);
    if (mi.decimals !== MUSD_DECIMALS || mi.freezeAuthority) {
      log.fail("mint must have 6 decimals and no freeze authority");
      exitWith(1);
    }
    log.ok(`mUSD ${mint.toBase58()}`);
  }

  log.step("Config");
  const cfg = await fetchExchangeConfig(p);
  if (cfg) {
    const checks: [string, PublicKey, PublicKey | undefined][] = [
      ["admin", cfg.admin, admin.publicKey],
      ["round_controller", cfg.roundController, controller],
      ["oracle_authority", cfg.oracleAuthority, oracle],
      ["collateral_mint", cfg.collateralMint, mint],
    ];
    for (const [name, onChain, want] of checks) {
      if (want && !onChain.equals(want)) {
        log.fail(`config.${name} = ${onChain.toBase58()}, expected ${want.toBase58()}`);
        problems++;
      }
    }
    log.ok(`exists ${exchangeConfigPda(p).toBase58()} (timeout ${cfg.resolutionTimeoutS} s)`);
  } else if (DRY_RUN || !mint) {
    log.todo(`initialize_config(controller=${controller.toBase58()}, oracle=${oracle.toBase58()}, timeout=${timeout})`);
  } else {
    const ix = await initializeExchangeConfigIx(p, { admin: admin.publicKey, roundController: controller, oracleAuthority: oracle, collateralMint: mint, resolutionTimeoutS: timeout });
    log.tx("initialize_config", await sendExchangeTx(conn, [ix], [admin]));
  }

  log.step("properties (data/properties.json, same three points as v1)");
  const registry = readJsonIfExists<ScenarioRegistry>(scenariosPath());
  const { rows, errors } = validateProperties(readJsonIfExists<unknown>(propertiesPath()), registry);
  for (const e of errors) log.fail(e);
  problems += errors.length;
  for (const r of rows) {
    const existing = await fetchProperty(p, r.property_id);
    if (existing) {
      const same = existing.latE6 === r.lat_e6 && existing.lonE6 === r.lon_e6 && existing.scenarioId === r.scenario_id && existing.triggerDistanceM === r.trigger_distance_m && existing.label === r.label;
      if (same) log.ok(`property ${r.property_id} "${r.label}"`);
      else {
        log.fail(`property ${r.property_id} is registered with different data`);
        problems++;
      }
    } else if (DRY_RUN || (!cfg && !mint)) {
      log.todo(`register_property(${r.property_id}, "${r.label}")`);
    } else {
      const ix = await registerExchangePropertyIx(p, admin.publicKey, {
        propertyId: r.property_id, label: encodeLabel(r.label), latE6: r.lat_e6, lonE6: r.lon_e6, scenarioId: r.scenario_id, triggerDistanceM: r.trigger_distance_m,
      });
      log.tx(`register_property ${r.property_id}`, await sendExchangeTx(conn, [ix], [admin]));
    }
  }
  if (LOCAL && (await getSolLamports(conn, admin.publicKey)) < solToLamports("1")) log.warn("admin has < 1 SOL");
  exitWith(problems);
}

main().catch((e: unknown) => {
  console.error(`setup-devnet-v2 failed: ${(e as Error).message}`);
  process.exit(1);
});
