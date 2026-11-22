import { describe, expect, it } from "vitest";
import { isTransientRpcError } from "./transient";

describe("transient RPC errors (docs/spec-simulation.md §9)", () => {
  it("provider and network hiccups are transient", () => {
    for (const m of ["503 Service Unavailable: ", "429 Too Many Requests: {}", "502 Bad Gateway", "fetch failed", "read ECONNRESET", "socket hang up"]) {
      expect(isTransientRpcError(new Error(m))).toBe(true);
    }
  });
  it("program and logic errors are not", () => {
    for (const m of ["custom program error: 0x177c", "InsufficientFunds: Not enough balance.", "Cannot read properties of undefined", "Transaction 5xy… failed for mint T001"]) {
      expect(isTransientRpcError(new Error(m))).toBe(false);
    }
    expect(isTransientRpcError({})).toBe(false);
  });
});
