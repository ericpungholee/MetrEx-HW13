import { describe, expect, it } from "vitest";
import { rpcMethods, V1_PROGRAM_ID } from "./rpc-proxy";

const call = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("rpc proxy allowlist", () => {
  it("forwards reads, simulation and sends, singly and batched", () => {
    expect(rpcMethods(call("getMultipleAccounts"))).toEqual(["getMultipleAccounts"]);
    expect(rpcMethods([call("simulateTransaction"), call("sendTransaction")])).toEqual(["simulateTransaction", "sendTransaction"]);
  });

  it("refuses scans of any program but v1, and unknown methods", () => {
    expect(rpcMethods(call("getProgramAccounts", [V1_PROGRAM_ID]))).toEqual(["getProgramAccounts"]);
    expect(rpcMethods(call("getProgramAccounts", ["BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko"]))).toMatch(/only allowed for the v1 program/);
    expect(rpcMethods(call("getProgramAccounts"))).toMatch(/only allowed/);
    expect(rpcMethods(call("requestAirdrop"))).toMatch(/not allowed/);
    expect(rpcMethods([call("getSlot"), call("requestAirdrop")])).toMatch(/not allowed/);
  });

  it("bounds batches and requires a method", () => {
    expect(rpcMethods([])).toBe("batch size");
    expect(rpcMethods(Array.from({ length: 21 }, () => call("getSlot")))).toBe("batch size");
    expect(rpcMethods({ jsonrpc: "2.0", id: 1 })).toBe("missing method");
  });
});
