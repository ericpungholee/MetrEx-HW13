// Startup guard (spec-v2 §8.4): bots never run where settlement data is configured.

export function assertNoOracleData(env: Record<string, string | undefined> = process.env): void {
  const v = env.METREX_ORACLE_DATA_DIR;
  if (v !== undefined && v.trim() !== "") {
    throw new Error("METREX_ORACLE_DATA_DIR is set. Bots must never have access to settlement data (spec-v2 §8.4). Refusing to start.");
  }
}
