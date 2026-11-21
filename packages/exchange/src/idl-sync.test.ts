// Guards the Gate V0 freeze: @metrex/exchange must match the committed metrex_exchange IDL.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as X from "./index";

interface Idl {
  instructions: Array<{ name: string; args: Array<{ name: string }> }>;
  accounts: Array<{ name: string }>;
  events: Array<{ name: string }>;
  errors: Array<{ code: number; name: string }>;
  constants: Array<{ name: string; value: string }>;
}
const idl = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../target/idl/metrex_exchange.json", import.meta.url)), "utf8"),
) as Idl;
const c = (name: string): string => {
  const v = idl.constants.find((x) => x.name === name);
  if (!v) throw new Error(`IDL constant ${name} missing`);
  return v.value;
};
const seedBytes = (s: string) => `[${Array.from(new TextEncoder().encode(s)).join(", ")}]`;

describe("IDL sync (V0 freeze)", () => {
  it("error codes and order match", () => {
    expect(idl.errors.map((e) => [e.code, e.name])).toEqual(X.ERROR_NAMES.map((n, i) => [X.ERROR_CODE_OFFSET + i, n]));
  });

  it("seeds match", () => {
    expect(c("CONFIG_SEED")).toBe(seedBytes(X.SEEDS.config));
    expect(c("PROPERTY_SEED")).toBe(seedBytes(X.SEEDS.property));
    expect(c("ROUND_SEED")).toBe(seedBytes(X.SEEDS.round));
    expect(c("MARKET_SEED")).toBe(seedBytes(X.SEEDS.market));
    expect(c("YES_MINT_SEED")).toBe(seedBytes(X.SEEDS.yesMint));
    expect(c("NO_MINT_SEED")).toBe(seedBytes(X.SEEDS.noMint));
    expect(c("VAULT_SEED")).toBe(seedBytes(X.SEEDS.vault));
    expect(c("ORDER_SEED")).toBe(seedBytes(X.SEEDS.order));
    expect(c("ESCROW_SEED")).toBe(seedBytes(X.SEEDS.escrow));
  });

  it("numeric constants match", () => {
    const pairs: Array<[string, bigint | number]> = [
      ["MUSD_DECIMALS", X.MUSD_DECIMALS],
      ["MUSD_UNIT", X.MUSD_UNIT],
      ["SHARE_DECIMALS", X.SHARE_DECIMALS],
      ["PAYOUT_PER_SHARE", X.PAYOUT_PER_SHARE],
      ["INVALID_PAYOUT_PER_SHARE", X.INVALID_PAYOUT_PER_SHARE],
      ["QUOTE_PER_SHARE_BPS", X.QUOTE_PER_SHARE_BPS],
      ["MIN_PRICE_BPS", X.MIN_PRICE_BPS],
      ["MAX_PRICE_BPS", X.MAX_PRICE_BPS],
      ["MIN_ORDER_QTY", X.MIN_ORDER_QTY],
      ["MAX_ORDER_QTY", X.MAX_ORDER_QTY],
      ["MAX_SPLIT_QTY", X.MAX_SPLIT_QTY],
      ["DEFAULT_TRIGGER_DISTANCE_M", X.DEFAULT_TRIGGER_DISTANCE_M],
      ["MAX_ABS_LAT_E6", X.MAX_ABS_LAT_E6],
      ["MAX_ABS_LON_E6", X.MAX_ABS_LON_E6],
      ["MIN_RESOLUTION_TIMEOUT_S", X.MIN_RESOLUTION_TIMEOUT_S],
      ["MAX_RESOLUTION_TIMEOUT_S", X.MAX_RESOLUTION_TIMEOUT_S],
      ["MAX_ROUND_DURATION_S", X.MAX_ROUND_DURATION_S],
      ["MAX_TAKE_LEVELS", X.MAX_TAKE_LEVELS],
      ["MAX_MATCH_LEVELS", X.MAX_MATCH_LEVELS],
      ["OUTCOME_YES", X.Outcome.Yes],
      ["OUTCOME_NO", X.Outcome.No],
      ["SIDE_BUY", X.OrderSide.Buy],
      ["SIDE_SELL", X.OrderSide.Sell],
      ["PATH_NONE", X.ResolutionPath.None],
      ["PATH_ORACLE", X.ResolutionPath.Oracle],
      ["PATH_EMERGENCY", X.ResolutionPath.Emergency],
      ["PATH_EXPIRY", X.ResolutionPath.Expiry],
      ["SCENARIO_PALISADES_2025", X.SCENARIO_PALISADES_2025],
      ["SCENARIO_HURRICANES_2017_09", X.SCENARIO_HURRICANES_2017_09],
      ["SCENARIO_SOUTH_NAPA_2014_08", X.SCENARIO_SOUTH_NAPA_2014_08],
      ["SCENARIO_IOWA_TORNADOES_2024_05", X.SCENARIO_IOWA_TORNADOES_2024_05],
      ["PROGRAM_VERSION", X.PROGRAM_VERSION],
    ];
    for (const [name, v] of pairs) expect(c(name), name).toBe(String(v));
  });

  it("instruction set and arguments are the frozen ones", () => {
    const sig = Object.fromEntries(idl.instructions.map((i) => [i.name, i.args.map((a) => a.name)]));
    expect(sig).toEqual({
      cancel_order: [],
      close_round: [],
      create_market: [],
      create_round: ["scenario_id", "dataset_sha256", "label", "trading_ends_at"],
      expire_market: [],
      initialize_config: ["round_controller", "oracle_authority", "resolution_timeout_s"],
      invalidate_market: ["reason"],
      match_orders: ["quantity"],
      merge: ["quantity"],
      place_order: ["client_nonce", "outcome", "side", "price_bps", "quantity", "expires_at"],
      redeem: ["outcome", "quantity"],
      register_property: ["property_id", "label", "lat_e6", "lon_e6", "scenario_id", "trigger_distance_m"],
      resolve_market: ["triggered", "evidence_hash"],
      split: ["quantity"],
      sweep_order: [],
      take_order: ["quantity", "limit_price_bps", "expected_seq"],
    });
    expect(idl.accounts.map((a) => a.name).sort()).toEqual(["Config", "Market", "Order", "Property", "Round"]);
    expect(idl.events.map((e) => e.name).sort()).toEqual(
      ["MarketCreated", "MarketResolved", "OrderCancelled", "OrderFilled", "OrderPlaced", "RoundClosed", "RoundCreated", "SharesMerged", "SharesRedeemed", "SharesSplit"],
    );
  });
});
