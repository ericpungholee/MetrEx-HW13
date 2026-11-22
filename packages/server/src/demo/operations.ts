// Operator-authorized demo operations (docs/spec-simulation.md §9): Reset Market and Reset Demo.
// One operation at a time, journaled in operation.json so a crash or restart resumes from its phase.
// Every capital movement is an explicit, journaled Devnet mint, burn or SOL transfer
// (DemoTransactions records signed bytes before broadcasting, so a resume never double-mints).
// Human wallets (Phantom, judges, the homeowner demo wallet) are never read for restoration,
// never signed for and never changed; their claims in settled rounds stay redeemable.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBurnInstruction, createCloseAccountInstruction, createMintToInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { CATALOG, Outcome, catalogByScenario, type OutcomeCode } from "@metrex/exchange";
import { ataOf, fetchRound, type MarketView, type RoundView } from "../exchange/accounts";
import { tokenAmountOf } from "../exchange/book";
import { holdClosure, releaseClosure } from "../exchange/closure-hold";
import {
  DEMO_TRADING_HOURS, MAKER_CAPITAL, MAKER_SOL_FLOAT, SIM_SOL_FLOAT, SPONSOR_SOL_FLOAT,
  readDemoOperation, writeDemoOperation, type DemoOperation,
} from "../exchange/demo-state";
import { DemoTransactions } from "../exchange/demo-transaction";
import { readHeartbeat } from "../exchange/heartbeat";
import { redeemIx } from "../exchange/ix";
import { getExchangeProgram } from "../exchange/program";
import { sendExchangeTx } from "../exchange";
import { keyDir, loadKeypair, loadKeypairFile, type KeypairName } from "../env";
import { settleRound, type SettleStep } from "../oracle/exchange-settle";
import { getRpc } from "../rpc";
import { musdMint } from "../token";
import { conflict } from "../routes/errors";
import { closeAndResolve, featuredRounds, openCatalogRound, roundMarkets, waitFinalizedClosed } from "./lifecycle";

export interface OperationLog {
  at: string;
  text: string;
  signature?: string | null;
}

export interface DemoOperationStatus extends DemoOperation {
  startedAt: string;
  updatedAt: string;
  error?: string;
  log: OperationLog[];
  timings: Record<string, number>;
}

const MAKERS: readonly KeypairName[] = ["botA", "botB", "botC"];
const LIMIT_ARCHETYPES = new Set(["homeowner", "risk", "quant"]);
let running: Promise<void> | null = null;

const now = () => new Date().toISOString();
export const currentOperation = (): DemoOperationStatus | undefined => readDemoOperation() as DemoOperationStatus | undefined;
export const operationRunning = (): boolean => running !== null;
/** Resolves when the operation started in this process settles (completed or stopped). */
export const awaitOperation = (): Promise<void> => running ?? Promise.resolve();

function save(op: DemoOperationStatus): void {
  op.updatedAt = now();
  writeDemoOperation(op);
}

function note(op: DemoOperationStatus, text: string, signature?: string | null): void {
  op.log.push({ at: now(), text, signature: signature ?? null });
  if (op.log.length > 400) op.log.splice(0, op.log.length - 400);
  save(op);
}

/**
 * Start (or resume) an operation in the background. Refuses while another operation is running in
 * this process, or while a different unfinished operation is journaled (resume that one instead).
 */
export function startOperation(action: "reset_market" | "reset_demo", rounds: string[], opts: { resume?: boolean; durationS?: bigint } = {}): DemoOperationStatus {
  if (running) throw conflict("Another demo operation is running");
  const prev = currentOperation();
  let op: DemoOperationStatus;
  if (prev && !prev.completed) {
    if (!opts.resume) throw conflict(`An unfinished ${prev.action.replace("_", " ")} is journaled; resume it first`);
    op = { ...prev, failed: false, error: undefined };
    note(op, "Resumed");
  } else {
    if (opts.resume) throw conflict("Nothing to resume");
    op = {
      id: randomUUID(), action, rounds, phase: "start", completed: false, replacements: {},
      startedAt: now(), updatedAt: now(), log: [], timings: {},
    };
    if (opts.durationS !== undefined) op.timings.durationS = Number(opts.durationS);
    save(op);
  }
  const t0 = Date.now();
  running = (op.action === "reset_demo" ? runResetDemo(op) : runResetMarket(op))
    .then(() => {
      op.completed = true;
      op.phase = "done";
      op.timings.totalMs = (op.timings.totalMs ?? 0) + Date.now() - t0;
      note(op, "Complete");
    })
    .catch((e: unknown) => {
      op.failed = true;
      op.error = e instanceof Error ? e.message : String(e);
      note(op, `Stopped: ${op.error}. Resume continues from phase "${op.phase}".`);
    })
    .finally(() => {
      running = null;
    });
  return op;
}

const durationOf = (op: DemoOperationStatus) => BigInt(op.timings.durationS ?? DEMO_TRADING_HOURS * 3600);

/** Close (if open) with the oracle's resolution in the same transaction, then finalize and sweep. */
async function settle(op: DemoOperationStatus, roundAddress: PublicKey): Promise<RoundView> {
  const rpc = getRpc();
  const round = await rpc.run((c) => fetchRound(getExchangeProgram(c), roundAddress, "confirmed"));
  if (!round) throw conflict(`Round ${roundAddress.toBase58()} not found`);
  if (round.status === "open") {
    holdClosure(round.address);
    try {
      const t = Date.now();
      const r = await closeAndResolve(round.address);
      op.timings[`redeemable_${round.roundId}`] = Date.now() - t;
      note(op, `Round #${round.roundId}: closed and resolved by the oracle (${r.resolved} market)`, r.signature);
    } finally {
      releaseClosure(round.address);
    }
  }
  await waitFinalizedClosed(round.address);
  const steps: SettleStep[] = await settleRound(round.address, {
    rpc, controller: loadKeypair("controller"), oracle: loadKeypair("oracle"), keeper: loadKeypair("keeper"),
  });
  for (const s of steps) if (s.signature || s.step !== "skip") note(op, `Round #${round.roundId}: ${s.step} ${s.note ?? ""}`.trim(), s.signature);
  const after = await rpc.run((c) => fetchRound(getExchangeProgram(c), round.address, "finalized"));
  if (!after || after.resolvedCount !== after.marketCount) throw conflict(`Round #${round.roundId} is not fully settled yet`);
  return after;
}

async function runResetMarket(op: DemoOperationStatus): Promise<void> {
  const roundAddress = new PublicKey(op.rounds[0]!);
  const old = await getRpc().run((c) => fetchRound(getExchangeProgram(c), roundAddress, "confirmed"));
  if (!old) throw conflict("Round not found");
  const entry = catalogByScenario(old.scenarioId);
  if (!entry) throw conflict("Only catalog rounds can be reset");
  op.phase = "settle";
  save(op);
  await settle(op, roundAddress);
  op.phase = "open";
  save(op);
  const opened = await openCatalogRound(entry, durationOf(op), old.roundId);
  for (const s of opened.signatures) note(op, `Round #${opened.round.roundId}: created`, s);
  op.replacements[roundAddress.toBase58()] = opened.market.toBase58();
  note(op, `Fresh ${entry.hazard} market ${opened.market.toBase58()} trading until ${new Date(Number(opened.round.tradingEndsAt) * 1000).toISOString()}. Makers quote it on their next tick; simulated traders resume.`);
}

interface SimRecord { index: number; id: string; archetype: string; address: string; capitalMusd: string }

function population(): Array<SimRecord & { keypair: Keypair }> {
  const rows = JSON.parse(readFileSync(join(keyDir(), "sim", "population.json"), "utf8")) as SimRecord[];
  return rows.map((r) => {
    const keypair = loadKeypairFile(join(keyDir(), "sim", `trader-${String(r.index + 1).padStart(3, "0")}.json`));
    if (keypair.publicKey.toBase58() !== r.address) throw conflict(`Simulated trader ${r.id} key does not match population.json`);
    return { ...r, keypair };
  });
}

/** Waits until a worker reports that it is held for the reset, or has stopped heartbeating. */
async function waitHeld(op: DemoOperationStatus, name: "sim" | "bots", timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hb = readHeartbeat(name);
    if (!hb.alive) return;
    const s = hb.heartbeat?.status ?? {};
    if (s.state === "reset_hold" && Number(s.inFlight ?? 0) === 0 && Date.parse(hb.heartbeat!.at) > start) return;
    await delay(1_000);
  }
  throw conflict(`The ${name} worker did not acknowledge the reset hold`);
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

async function runResetDemo(op: DemoOperationStatus): Promise<void> {
  const rpc = getRpc();
  const p = () => getExchangeProgram(rpc.connection);
  const mint = musdMint();
  const traders = population();
  const makers = MAKERS.map((k) => ({ name: k, keypair: loadKeypair(k) }));
  const sponsor = loadKeypair("simSponsor");
  const journal = new DemoTransactions(rpc, `reset-${op.id}.json`);
  await journal.recover();

  // 1. Hold every local signer: the simulator and the makers stop and drain in-flight transactions.
  if (op.phase === "start" || op.phase === "hold") {
    op.phase = "hold";
    save(op);
    await Promise.all([waitHeld(op, "sim"), waitHeld(op, "bots")]);
    note(op, "Simulated traders and makers are held");
  }

  // 2. Settle every featured catalog round through the oracle (archived, never erased).
  if (op.phase === "hold" || op.phase === "settle") {
    op.phase = "settle";
    if (!op.rounds.length) op.rounds = [...(await featuredRounds()).values()].map((r) => r.address.toBase58());
    save(op);
    const t = Date.now();
    await pool(op.rounds, 4, async (r) => {
      await settle(op, new PublicKey(r));
    });
    op.timings.settleMs = Date.now() - t;
  }

  // 3. Redeem simulated traders' and makers' winning shares in the settled rounds (sweeps already
  //    returned every escrow). Idempotent from chain balances: nothing held means nothing sent.
  if (op.phase === "settle" || op.phase === "redeem") {
    op.phase = "redeem";
    save(op);
    const t = Date.now();
    const markets: MarketView[] = [];
    for (const r of op.rounds) {
      const round = await rpc.run((c) => fetchRound(getExchangeProgram(c), new PublicKey(r), "finalized"));
      if (round) markets.push(...(await roundMarkets(round, "finalized")));
    }
    const wallets = [...traders.map((t) => ({ owner: t.keypair, payer: sponsor })), ...makers.map((m) => ({ owner: m.keypair, payer: m.keypair }))];
    const sigs: string[] = [];
    await pool(wallets, 8, async ({ owner, payer }) => {
      const keys = markets.flatMap((m) => [ataOf(m.yesMint, owner.publicKey), ataOf(m.noMint, owner.publicKey)]);
      const infos = await rpc.run((c) => c.getMultipleAccountsInfo(keys, "finalized"));
      for (const [i, m] of markets.entries()) {
        const yes = tokenAmountOf(infos[2 * i]);
        const no = tokenAmountOf(infos[2 * i + 1]);
        const want: Array<[OutcomeCode, bigint]> = [];
        if ((m.outcome === "yes" || m.outcome === "invalid") && yes > 0n) want.push([Outcome.Yes, yes]);
        if ((m.outcome === "no" || m.outcome === "invalid") && no > 0n) want.push([Outcome.No, no]);
        const ixs: TransactionInstruction[] = await Promise.all(want.map(([o, q]) => redeemIx(p(), m, owner.publicKey, mint, o, q)));
        // Simulated traders' outcome accounts were opened by the sponsor: once empty, the rent goes back to it.
        if (payer !== owner) {
          const redeemedSide = new Set(want.map(([o]) => o));
          const sides: Array<[OutcomeCode, PublicKey, bigint, boolean]> = [[Outcome.Yes, m.yesMint, yes, infos[2 * i] !== null], [Outcome.No, m.noMint, no, infos[2 * i + 1] !== null]];
          for (const [o, sideMint, amount, exists] of sides) {
            if (exists && (amount === 0n || redeemedSide.has(o))) ixs.push(createCloseAccountInstruction(ataOf(sideMint, owner.publicKey), payer.publicKey, owner.publicKey, [], TOKEN_PROGRAM_ID));
          }
        }
        if (!ixs.length) continue;
        const signers = payer === owner ? [owner] : [payer, owner];
        sigs.push(await sendExchangeTx(rpc.connection, ixs, signers, { commitment: "confirmed" }));
      }
    });
    // Capital is computed from finalized balances, so every redemption must be finalized first.
    await waitFinalized(sigs);
    op.timings.redeemMs = Date.now() - t;
    note(op, `${sigs.length} redemption transactions (emptied simulated accounts closed, rent to the sponsor), all finalized`);
  }

  // 4. Restore seeded capital exactly: mint the shortfall or burn the excess, per wallet.
  if (op.phase === "redeem" || op.phase === "capital") {
    op.phase = "capital";
    save(op);
    const t = Date.now();
    const mintAuthority = loadKeypair("mintAuthority");
    const funder = loadKeypair("deployer");
    const targets = [
      ...traders.map((t) => ({ id: t.id, owner: t.keypair, payer: sponsor, target: BigInt(t.capitalMusd) * 1_000_000n })),
      ...makers.map((m) => ({ id: `maker ${m.name}`, owner: m.keypair, payer: m.keypair, target: MAKER_CAPITAL })),
    ];
    const atas = targets.map((x) => ataOf(mint, x.owner.publicKey));
    const infos: Array<AccountInfo<Buffer> | null> = [];
    for (let i = 0; i < atas.length; i += 100) infos.push(...(await rpc.run((c) => c.getMultipleAccountsInfo(atas.slice(i, i + 100), "finalized"))));
    let minted = 0n;
    let burned = 0n;
    const mints: Array<{ id: string; ata: PublicKey; amount: bigint }> = [];
    const burns: Array<{ id: string; ata: PublicKey; owner: Keypair; payer: Keypair; amount: bigint }> = [];
    targets.forEach((x, i) => {
      const have = tokenAmountOf(infos[i]);
      if (!infos[i]) throw conflict(`${x.id} has no mUSD account; run provision-sim first`);
      if (have < x.target) mints.push({ id: x.id, ata: atas[i]!, amount: x.target - have });
      else if (have > x.target) burns.push({ id: x.id, ata: atas[i]!, owner: x.owner, payer: x.payer, amount: have - x.target });
    });
    const mintBatches: (typeof mints)[] = [];
    for (let i = 0; i < mints.length; i += 8) mintBatches.push(mints.slice(i, i + 8));
    await pool(mintBatches, 4, async (batch) => {
      const sig = await journal.send(`mint ${batch.map((b) => b.id).join("+")}`, async () => ({
        instructions: batch.map((b) => createMintToInstruction(mint, b.ata, mintAuthority.publicKey, b.amount, [], TOKEN_PROGRAM_ID)),
        signers: [funder, mintAuthority],
      }));
      for (const b of batch) minted += b.amount;
      note(op, `Minted ${batch.map((b) => `${b.id} +${b.amount / 1_000_000n}`).join(", ")} mUSD`, sig);
    });
    await pool(burns, 6, async (b) => {
      const ix: TransactionInstruction = createBurnInstruction(b.ata, mint, b.owner.publicKey, b.amount, [], TOKEN_PROGRAM_ID);
      const sig = await journal.send(`burn ${b.id}`, async () => ({ instructions: [ix], signers: b.payer === b.owner ? [b.owner] : [b.payer, b.owner] }));
      burned += b.amount;
      note(op, `Burned ${b.id} −${b.amount / 1_000_000n} mUSD`, sig);
    });
    op.timings.capitalMs = Date.now() - t;
    note(op, `Capital restored: ${targets.length - mints.length - burns.length} wallets already exact, ${mints.length} minted (${minted / 1_000_000n} mUSD), ${burns.length} burned (${burned / 1_000_000n} mUSD)`);
  }

  // 5. SOL floats, only where a wallet fell below its float.
  if (op.phase === "capital" || op.phase === "sol") {
    op.phase = "sol";
    save(op);
    const funder = loadKeypair("deployer");
    const want: Array<[string, PublicKey, bigint]> = [
      ["sponsor", sponsor.publicKey, SPONSOR_SOL_FLOAT],
      ...makers.map((m): [string, PublicKey, bigint] => [m.name, m.keypair.publicKey, MAKER_SOL_FLOAT]),
      ...traders.filter((t) => LIMIT_ARCHETYPES.has(t.archetype)).map((t): [string, PublicKey, bigint] => [t.id, t.keypair.publicKey, SIM_SOL_FLOAT]),
    ];
    const infos = await rpc.run((c) => c.getMultipleAccountsInfo(want.map(([, k]) => k), "finalized"));
    // Refill only below 2/3 of the float, to the float.
    const short = want.flatMap(([name, k, target], i) => {
      const have = BigInt(infos[i]?.lamports ?? 0);
      return have * 3n < target * 2n ? [{ name, k, need: target - have }] : [];
    });
    for (let i = 0; i < short.length; i += 10) {
      const batch = short.slice(i, i + 10);
      const sig = await journal.send(`sol ${batch.map((b) => b.name).join("+")}`, async () => ({
        instructions: batch.map((b) => SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: b.k, lamports: b.need })),
        signers: [funder],
      }));
      note(op, `SOL float restored for ${batch.map((b) => b.name).join(", ")}`, sig);
    }
    if (!short.length) note(op, "SOL floats already sufficient");
  }

  // 6. Four fresh catalog rounds with the full trading window; workers resume when this completes.
  if (op.phase === "sol" || op.phase === "open") {
    op.phase = "open";
    save(op);
    for (const entry of CATALOG) {
      const old = await featuredOld(op, entry.scenarioId);
      const opened = await openCatalogRound(entry, durationOf(op), old?.roundId ?? null);
      if (old) op.replacements[old.address.toBase58()] = opened.market.toBase58();
      for (const s of opened.signatures) note(op, `Round #${opened.round.roundId} (${entry.hazard}): created`, s);
    }
  }
}

async function waitFinalized(sigs: string[], timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let left = [...sigs];
  while (left.length) {
    if (Date.now() > deadline) throw conflict(`${left.length} redemptions have not finalized yet`);
    const next: string[] = [];
    for (let i = 0; i < left.length; i += 200) {
      const chunk = left.slice(i, i + 200);
      const st = await getRpc().run((c) => c.getSignatureStatuses(chunk, { searchTransactionHistory: true }));
      chunk.forEach((s, j) => { if (st.value[j]?.confirmationStatus !== "finalized") next.push(s); });
    }
    left = next;
    if (left.length) await delay(2_000);
  }
}

async function featuredOld(op: DemoOperationStatus, scenarioId: number): Promise<RoundView | null> {
  for (const r of op.rounds) {
    const round = await getRpc().run((c) => fetchRound(getExchangeProgram(c), new PublicKey(r), "finalized"));
    if (round?.scenarioId === scenarioId) return round;
  }
  return null;
}
