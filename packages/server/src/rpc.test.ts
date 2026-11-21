import { describe, expect, it } from "vitest";
import { RequestPacer } from "./rpc";

describe("RequestPacer (client-side RPC cap)", () => {
  it("spaces requests 1000/maxRps ms apart and never delays an idle pool", () => {
    let t = 1_000;
    const p = new RequestPacer(10, () => t);
    expect([p.reserve(), p.reserve(), p.reserve()]).toEqual([0, 100, 200]);
    t += 1_000; // idle for a second: the next request goes out at once
    expect(p.reserve()).toBe(0);
  });

  it("does nothing without a cap", () => {
    const p = new RequestPacer(undefined);
    expect([p.reserve(), p.reserve()]).toEqual([0, 0]);
  });

  it("counts requests by JSON-RPC method and reports the window", () => {
    let t = 0;
    const p = new RequestPacer(20, () => t);
    p.record(JSON.stringify({ method: "getMultipleAccounts" }));
    p.record(JSON.stringify({ method: "getProgramAccounts" }));
    p.record(JSON.stringify({ method: "getProgramAccounts" }));
    p.record(JSON.stringify([{ method: "getTransaction" }, { method: "getTransaction" }]));
    t = 10_000;
    expect(p.report()).toBe("4 req in 10 s (0.4/s, cap 20/s): getProgramAccounts 2, getMultipleAccounts 1, batch:getTransaction 1");
    expect(p.total).toBe(4);
    t = 20_000;
    expect(p.report()).toMatch(/^0 req in 10 s/);
  });
});
