// Guards the Gate 0 freeze: @metrex/shared must match the committed IDL.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BPS_DENOMINATOR,
  DEFAULT_TRIGGER_DISTANCE_M,
  ERROR_CODE_OFFSET,
  ERROR_NAMES,
  MAX_BPS,
  MAX_COVERAGE_TARGET,
  MIN_BPS,
  MIN_COVERAGE,
  SEEDS,
  Side,
} from "./index";

interface Idl {
  errors: Array<{ code: number; name: string }>;
  constants: Array<{ name: string; value: string }>;
  accounts: Array<{ name: string }>;
}

const idl = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../target/idl/metrex.json", import.meta.url)), "utf8"),
) as Idl;

const constant = (name: string): string => {
  const c = idl.constants.find((x) => x.name === name);
  if (!c) throw new Error(`IDL constant ${name} missing`);
  return c.value;
};

const seedBytes = (s: string): string => `[${Array.from(new TextEncoder().encode(s)).join(", ")}]`;

describe("IDL sync", () => {
  it("error codes match", () => {
    expect(idl.errors.map((e) => [e.code, e.name])).toEqual(
      ERROR_NAMES.map((n, i) => [ERROR_CODE_OFFSET + i, n]),
    );
  });

  it("seeds match", () => {
    expect(constant("CONFIG_SEED")).toBe(seedBytes(SEEDS.config));
    expect(constant("PROPERTY_SEED")).toBe(seedBytes(SEEDS.property));
    expect(constant("MARKET_SEED")).toBe(seedBytes(SEEDS.market));
    expect(constant("OFFER_SEED")).toBe(seedBytes(SEEDS.offer));
    expect(constant("VAULT_SEED")).toBe(seedBytes(SEEDS.vault));
    expect(constant("LISTING_SEED")).toBe(seedBytes(SEEDS.listing));
  });

  it("bounds match", () => {
    expect(BigInt(constant("MAX_BPS"))).toBe(BigInt(MAX_BPS));
    expect(BigInt(constant("MIN_BPS"))).toBe(BigInt(MIN_BPS));
    expect(BigInt(constant("MIN_COVERAGE"))).toBe(MIN_COVERAGE);
    expect(BigInt(constant("MAX_COVERAGE_TARGET"))).toBe(MAX_COVERAGE_TARGET);
    expect(BigInt(constant("BPS_DENOMINATOR"))).toBe(BPS_DENOMINATOR);
    expect(Number(constant("DEFAULT_TRIGGER_DISTANCE_M"))).toBe(DEFAULT_TRIGGER_DISTANCE_M);
    expect(Number(constant("SIDE_PROTECTION"))).toBe(Side.Protection);
    expect(Number(constant("SIDE_RISK"))).toBe(Side.Risk);
  });

  it("account set matches", () => {
    expect(idl.accounts.map((a) => a.name).sort()).toEqual(
      ["Config", "Listing", "Market", "Offer", "Property"],
    );
  });
});
