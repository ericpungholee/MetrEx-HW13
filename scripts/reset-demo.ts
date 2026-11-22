// reset-demo.ts: run (or resume) the operator's Reset Demo from a terminal, the same journaled
// operation as POST /api/operator/demo (docs/spec-simulation.md §9). Use it when the app is not running, or
// to recover. Stop or let the workers acknowledge the hold first; human wallets are never touched.
//   METREX_ORACLE_DATA_DIR=… pnpm tsx scripts/reset-demo.ts [--resume]
import { awaitOperation, currentOperation, startOperation } from "@metrex/server";
import { DEVNET_GENESIS, explorerTx, getRpc } from "@metrex/server/exchange";
import { args } from "./lib/common";

async function main(): Promise<void> {
  if (await getRpc().run((c) => c.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Devnet only");
  if (!process.env.METREX_ORACLE_DATA_DIR) throw new Error("Set METREX_ORACLE_DATA_DIR");
  const op = startOperation("reset_demo", [], { resume: args.includes("--resume") });
  let shown = 0;
  const timer = setInterval(() => {
    const cur = currentOperation();
    for (const l of cur?.log.slice(shown) ?? []) console.log(`${l.at.slice(11, 19)} ${l.text}${l.signature ? ` ${explorerTx(l.signature)}` : ""}`);
    shown = cur?.log.length ?? shown;
  }, 1_000);
  await awaitOperation();
  clearInterval(timer);
  const done = currentOperation();
  for (const l of done?.log.slice(shown) ?? []) console.log(`${l.at.slice(11, 19)} ${l.text}${l.signature ? ` ${explorerTx(l.signature)}` : ""}`);
  console.log(JSON.stringify({ id: op.id, phase: done?.phase, completed: done?.completed, timings: done?.timings }));
  process.exit(done?.completed ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(`reset-demo failed: ${(e as Error).message}`);
  process.exit(1);
});
