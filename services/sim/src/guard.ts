// Startup guard (spec-v2 §8.4, docs/spec-simulation.md §1.5): the simulator never runs where
// settlement data is configured.

export function assertNoOracleData(env: Record<string, string | undefined> = process.env): void {
  const v = env.METREX_ORACLE_DATA_DIR;
  if (v !== undefined && v.trim() !== "") {
    throw new Error("METREX_ORACLE_DATA_DIR is set. Simulated traders must never have access to settlement data. Refusing to start.");
  }
}
