// One foreground supervisor. The app receives oracle configuration and the workers do not.
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getMint } from "@solana/spl-token";
import { CATALOG, Outcome, crossBookArbitrage } from "@metrex/exchange";
import { FAUCET_RESERVE_LAMPORTS, FAUCET_SOL_LAMPORTS } from "@metrex/server";
import {
  ExchangeStateLoader, ataOf, exchangeProgramId, getRpc, loadKeypair, lockWorker, repoRoot, solToLamports,
  tokenAmountOf,
} from "@metrex/server/exchange";
import { checkBotsQuoting, DEVNET_GENESIS } from "./lib/v2";

const cwd = repoRoot();
const port = Number(process.env.METREX_PORT ?? 3015);
const origin = `http://127.0.0.1:${port}`;
const jobs = new Set<ChildProcess>();
const signerNames = ["botA", "botB", "botC", "keeper", "faucet"] as const;
const rpc = getRpc();
let stopping = false;

function launch(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", detached: true });
    jobs.add(child);
    child.once("error", reject);
    child.once("exit", (code) => {
      jobs.delete(child);
      if (code === 0 || stopping) resolve();
      else reject(new Error(`${command} ${args[0]} exited with status ${code}`));
    });
  });
}

function stop(): void {
  stopping = true;
  for (const child of jobs) if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
}

async function main(): Promise<void> {
  if (process.env.NEXT_PUBLIC_USE_FIXTURES === "1") throw new Error("Unset fixture mode before starting the demo");
  if (!process.env.METREX_ORACLE_DATA_DIR || !process.env.DEMO_PASSWORD) throw new Error("Set METREX_ORACLE_DATA_DIR and DEMO_PASSWORD");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid METREX_PORT");
  const unlock = await lockWorker(exchangeProgramId(), [loadKeypair("controller").publicKey]);
  const appEnv = { ...process.env, METREX_APP_ORIGIN: origin };
  const workerEnv = { ...process.env };
  for (const name of ["METREX_ORACLE_DATA_DIR", "DEMO_PASSWORD", "ORACLE_KEYPAIR", "CONTROLLER_KEYPAIR", "ADMIN_KEYPAIR", "MINT_AUTHORITY_KEYPAIR", "FAUCET_KEYPAIR"]) {
    delete workerEnv[name];
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (await rpc.run((c) => c.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("The demo launcher requires Devnet");
    const loader = new ExchangeStateLoader();
    const wallet = Object.fromEntries(signerNames.map((name) => [name, loadKeypair(name).publicKey])) as Record<typeof signerNames[number], ReturnType<typeof loadKeypair>["publicKey"]>;
    const state = await rpc.run((c) => loader.load(c, { extraKeys: (_m, config) =>
      Object.values(wallet).flatMap((k) => [k, ataOf(config.collateralMint, k)]),
    }));
    if (!state) throw new Error("Exchange Config unavailable");
    const mint = await rpc.run((c) => getMint(c, state.config.collateralMint, "finalized"));
    if (mint.decimals !== 6 || mint.freezeAuthority || !mint.mintAuthority?.equals(loadKeypair("mintAuthority").publicKey)) {
      throw new Error("Collateral mint configuration does not match the demo");
    }
    for (const name of signerNames) {
      const k = wallet[name];
      const lamports = BigInt(state.extra.get(k.toBase58())?.lamports ?? 0);
      const musd = tokenAmountOf(state.extra.get(ataOf(state.config.collateralMint, k).toBase58()));
      console.log(`[demo] ${name} ${lamports} lamports, ${musd} mUSD base units free`);
      const floor = name === "faucet" ? FAUCET_SOL_LAMPORTS + FAUCET_RESERVE_LAMPORTS : solToLamports("0.01");
      if (lamports <= floor) throw new Error(`Top up ${name} before starting`);
    }
    if (stopping) return;
    await launch(process.execPath, ["--import", "tsx", "scripts/prepare-multiperil.ts", "--prepare-only", "--advance-expired", ...process.argv.slice(2)], appEnv);
    if (stopping) return;
    await launch("pnpm", ["--filter", "app", "build"], appEnv);
    if (stopping) return;

    const launchedAt = Date.now();
    const workers = Promise.race([
      launch(process.execPath, ["--import", "tsx", "services/bots/src/v2/index.ts"], workerEnv),
      launch(process.execPath, ["--import", "tsx", "services/indexer/src/v2.ts"], workerEnv),
      launch("pnpm", ["--filter", "app", "start", "--hostname", "127.0.0.1", "--port", String(port)], appEnv),
    ]).then(() => { if (!stopping) throw new Error("A demo service stopped"); });
    const ready = async () => {
      const bots = Object.fromEntries((["A", "B", "C"] as const).map((b) => [wallet[`bot${b}`].toBase58(), b]));
      const deadline = Date.now() + 120_000;
      while (!stopping && Date.now() < deadline) {
        const [health, live] = await Promise.all([
          fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null),
          rpc.run((c) => loader.load(c)).catch(() => null),
        ]);
        const freshWorkers = Date.parse(health?.bots?.heartbeat?.at ?? "") >= launchedAt &&
          Date.parse(health?.keeper?.heartbeat?.at ?? "") >= launchedAt;
        if (health?.rpc?.ok && health.matching === "running" && health.bots?.alive && freshWorkers && live && CATALOG.every((item) => {
          const s = [...live.snapshots].reverse().find((x) => x.market.propertyId === item.propertyId && x.round.scenarioId === item.scenarioId);
          if (!s?.tradingOpen || checkBotsQuoting(s.book, bots).length) return false;
          return crossBookArbitrage(s.book.map((o) => ({ ...o, isBot: o.maker in bots }))).length === 0 &&
            [Outcome.Yes, Outcome.No].every((outcome) => s.book.filter((o) => o.outcome === outcome).length >= 6);
        })) {
          console.log(`[demo] ready at ${origin}. Four open markets, executable books and healthy workers.`);
          return;
        }
        await delay(2_000);
      }
      if (!stopping) throw new Error("The demo did not reach readiness within 120 seconds");
    };
    await Promise.race([workers, ready()]);
    await workers;
  } finally {
    stop();
    unlock();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
