// Constants, seeds and error names (spec-v2 §3, §6). FROZEN at Gate V0; must match the IDL
// (`idl-sync.test.ts`). Token amounts are bigint base units; shares are bigint whole units.

export const MUSD_DECIMALS = 6;
export const MUSD_UNIT = 1_000_000n;
export const SHARE_DECIMALS = 0;
export const PAYOUT_PER_SHARE = 1_000_000n;
export const INVALID_PAYOUT_PER_SHARE = 500_000n;
export const QUOTE_PER_SHARE_BPS = 100n;

export const MIN_PRICE_BPS = 1;
export const MAX_PRICE_BPS = 9_999;
export const BPS_DENOMINATOR = 10_000;
export const MIN_ORDER_QTY = 1n;
export const MAX_ORDER_QTY = 1_000_000n;
export const MAX_SPLIT_QTY = 1_000_000n;
export const DEFAULT_TRIGGER_DISTANCE_M = 500;
export const MAX_ABS_LAT_E6 = 90_000_000;
export const MAX_ABS_LON_E6 = 180_000_000;
export const MIN_RESOLUTION_TIMEOUT_S = 10;
export const MAX_RESOLUTION_TIMEOUT_S = 30 * 24 * 60 * 60;
export const MAX_ROUND_DURATION_S = 30 * 24 * 60 * 60;
/** Devnet policy (§6.1): `setup-devnet-v2.ts` refuses a shorter timeout. */
export const DEVNET_MIN_RESOLUTION_TIMEOUT_S = 86_400;

export const MAX_TAKE_LEVELS = 4;
export const MAX_MATCH_LEVELS = 3;

export const SCENARIO_PALISADES_2025 = 1;
export const PROGRAM_VERSION = 2;

export const Outcome = { Yes: 0, No: 1 } as const;
export type OutcomeCode = (typeof Outcome)[keyof typeof Outcome];
export const OrderSide = { Buy: 0, Sell: 1 } as const;
export type OrderSideCode = (typeof OrderSide)[keyof typeof OrderSide];
export const ResolutionPath = { None: 0, Oracle: 1, Emergency: 2, Expiry: 3 } as const;
export type ResolutionPathCode = (typeof ResolutionPath)[keyof typeof ResolutionPath];

export const SEEDS = {
  config: "config",
  property: "property",
  round: "round",
  market: "market",
  yesMint: "yes_mint",
  noMint: "no_mint",
  vault: "vault",
  order: "order",
  escrow: "escrow",
} as const;

export const ERROR_CODE_OFFSET = 6000;
export const ERROR_NAMES = [
  "Unauthorized",
  "InvalidMint",
  "InvalidTokenAccount",
  "InvalidMintConfig",
  "RoleConflict",
  "InvalidCoordinates",
  "InvalidTriggerDistance",
  "UnsupportedScenario",
  "ScenarioMismatch",
  "PreviousRoundOpen",
  "InvalidDeadline",
  "InvalidTimeout",
  "RoundNotOpen",
  "TradingEnded",
  "RoundNotClosed",
  "MarketResolved",
  "MarketNotResolved",
  "ResolutionWindowClosed",
  "ResolutionWindowOpen",
  "InvalidEvidenceHash",
  "InvalidOutcome",
  "InvalidSide",
  "InvalidPrice",
  "InvalidQuantity",
  "InvalidExpiry",
  "OrderExpired",
  "OrderNotActive",
  "OrderMismatch",
  "OrderSeqMismatch",
  "OrdersDoNotCross",
  "PriceLimitExceeded",
  "SelfTrade",
  "NotSweepable",
  "InsufficientPairs",
  "LosingOutcome",
  "InsufficientFunds",
  "MathOverflow",
  "NotImplemented",
] as const;
export type ErrorName = (typeof ERROR_NAMES)[number];
