import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  MUSD_UNIT,
  Side,
  computeOfferTerms,
  decodeLabel,
  encodeLabel,
  errorCode,
  errorNameOf,
  findListingPda,
  findMarketPda,
  findOfferPda,
  findPropertyPda,
  marketDisplayState,
  u16LE,
  u64LE,
} from "./index";

const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

describe("offer math (§4.2, §4.3)", () => {
  it("matches the worked example", () => {
    const rows: Array<[bigint, number, bigint, bigint]> = [
      [4_000n, 400, 160n, 3_840n],
      [3_000n, 450, 135n, 2_865n],
      [3_000n, 500, 150n, 2_850n],
    ];
    for (const [c, bps, p, k] of rows) {
      const t = computeOfferTerms(c * MUSD_UNIT, bps);
      expect(t.premium).toBe(p * MUSD_UNIT);
      expect(t.collateral).toBe(k * MUSD_UNIT);
      expect(t.premium + t.collateral).toBe(t.coverage);
    }
  });

  it("floors the premium", () => {
    expect(computeOfferTerms(9_999n, 1).premium).toBe(0n);
    expect(computeOfferTerms(10_001n, 1).premium).toBe(1n);
  });

  it("rejects bps 0 and 10,000", () => {
    expect(() => computeOfferTerms(1n, 0)).toThrow(RangeError);
    expect(() => computeOfferTerms(1n, 10_000)).toThrow(RangeError);
  });
});

describe("PDA seeds (§5)", () => {
  it("encodes integers little-endian", () => {
    expect(Array.from(u16LE(0x0102))).toEqual([0x02, 0x01]);
    expect(Array.from(u64LE(1n))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(u64LE(new BN(256)))).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    expect(() => u64LE(-1n)).toThrow(RangeError);
  });

  it("derives distinct, deterministic addresses", () => {
    const homeowner = PublicKey.unique();
    const underwriter = PublicKey.unique();
    const [market] = findMarketPda(PROGRAM_ID, homeowner, 42n);
    expect(findMarketPda(PROGRAM_ID, homeowner, new BN(42))[0].equals(market)).toBe(true);
    const [offerA] = findOfferPda(PROGRAM_ID, market, underwriter, 1n);
    const [offerB] = findOfferPda(PROGRAM_ID, market, underwriter, 2n);
    expect(offerA.equals(offerB)).toBe(false);
    const [p] = findListingPda(PROGRAM_ID, offerA, Side.Protection);
    const [r] = findListingPda(PROGRAM_ID, offerA, Side.Risk);
    expect(p.equals(r)).toBe(false);
    expect(findPropertyPda(PROGRAM_ID, 1)[0].equals(findPropertyPda(PROGRAM_ID, 2)[0])).toBe(false);
  });
});

describe("labels (§5.2)", () => {
  it("round-trips and zero-pads to 32 bytes", () => {
    const enc = encodeLabel("Palisades · Home #1042");
    expect(enc).toHaveLength(32);
    expect(decodeLabel(enc)).toBe("Palisades · Home #1042");
    expect(() => encodeLabel("x".repeat(33))).toThrow(RangeError);
  });
});

describe("errors (§6.4)", () => {
  it("numbers codes from 6000 in spec order", () => {
    expect(errorCode("Unauthorized")).toBe(6000);
    expect(errorCode("InvalidPrice")).toBe(6019);
    expect(errorCode("InvalidSide")).toBe(6021);
    expect(errorNameOf(6007)).toBe("PremiumRoundsToZero");
  });
});

describe("display states (§10.2)", () => {
  it("derives Funded and Accepting offers from Open", () => {
    const open = { open: {} } as const;
    expect(
      marketDisplayState({ status: open, coverageActivated: new BN(5), coverageTarget: new BN(10) }),
    ).toBe("Accepting offers");
    expect(
      marketDisplayState({ status: open, coverageActivated: new BN(10), coverageTarget: new BN(10) }),
    ).toBe("Funded");
    expect(
      marketDisplayState({
        status: { resolvedNo: {} },
        coverageActivated: new BN(10),
        coverageTarget: new BN(10),
      }),
    ).toBe("Resolved: not triggered");
  });
});
