import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { findMarketPda, findRoundPda, marketAddresses, payoutPerShare, quote, splitAmount, vaultObligation } from "./index";

describe("money math (§3, §4)", () => {
  it("quote is exact: 100 shares @ 400 bps = 4 mUSD (the draft's 40 was wrong)", () => {
    expect(quote(100n, 400)).toBe(4_000_000n);
    expect(quote(10_000n, 400)).toBe(400_000_000n); // §4.2: 400 mUSD premium
    expect(quote(1n, 1)).toBe(100n);
    expect(quote(1_000_000n, 9_999)).toBe(999_900_000_000n);
  });

  it("rejects out-of-range prices", () => {
    expect(() => quote(1n, 0)).toThrow();
    expect(() => quote(1n, 10_000)).toThrow();
    expect(() => quote(1n, 1.5)).toThrow();
  });

  it("payout table (§4.4)", () => {
    expect(payoutPerShare("yes", 0)).toBe(1_000_000n);
    expect(payoutPerShare("yes", 1)).toBe(0n);
    expect(payoutPerShare("no", 1)).toBe(1_000_000n);
    expect(payoutPerShare("invalid", 0)).toBe(500_000n);
    expect(payoutPerShare("invalid", 1)).toBe(500_000n);
    expect(payoutPerShare("unresolved", 0)).toBe(0n);
  });

  it("worked example §4.2 nets out", () => {
    const deposit = splitAmount(10_000n);
    const premium = quote(10_000n, 400);
    // YES: homeowner +9,600, underwriter −9,600; NO: −400 / +400; Invalid: +4,600 / −4,600.
    expect(10_000n * payoutPerShare("yes", 0) - premium).toBe(9_600_000_000n);
    expect(premium + 10_000n * payoutPerShare("no", 1) - deposit).toBe(400_000_000n);
    expect(10_000n * payoutPerShare("invalid", 0) - premium).toBe(4_600_000_000n);
  });

  it("vault obligation (§4.6)", () => {
    const base = { pairsOutstanding: 10n, yesSupply: 7n, noSupply: 10n };
    expect(vaultObligation({ ...base, outcome: "unresolved" })).toBe(10_000_000n);
    expect(vaultObligation({ ...base, outcome: "yes" })).toBe(7_000_000n);
    expect(vaultObligation({ ...base, outcome: "no" })).toBe(10_000_000n);
    expect(vaultObligation({ ...base, outcome: "invalid" })).toBe(8_500_000n);
  });

  it("market PDAs are per (round, property), so a new round never reuses a market", () => {
    const pid = new PublicKey("BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko");
    const [r1] = findRoundPda(pid, 1n);
    const [r2] = findRoundPda(pid, 2n);
    expect(findMarketPda(pid, r1, 1)[0].equals(findMarketPda(pid, r2, 1)[0])).toBe(false);
    const a = marketAddresses(pid, r1, 1);
    expect(new Set([a.market, a.yesMint, a.noMint, a.vault].map(String)).size).toBe(4);
  });
});
