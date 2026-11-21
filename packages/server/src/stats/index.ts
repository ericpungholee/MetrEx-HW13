// GET /api/stats entry point: one process-wide indexer over the default RPC pool.

import { programId } from "../program";
import { getRpc } from "../rpc";
import { connectionSource, ProgramIndexer, type ProgramStats } from "./indexer";

export * from "./indexer";

let indexer: ProgramIndexer | undefined;

export function getIndexer(): ProgramIndexer {
  if (!indexer) {
    const pid = programId();
    const rpc = getRpc();
    indexer = new ProgramIndexer(pid.toBase58(), connectionSource(() => rpc.connection, pid));
  }
  return indexer;
}

export function getStats(): Promise<ProgramStats> {
  return getIndexer().getStats();
}
