// Plain-words messages for program errors (spec-v2 §10.3: "shows a program error in plain words").
// Policy text, not frozen. Names and codes come from the frozen ERROR_NAMES.

import { ERROR_CODE_OFFSET, ERROR_NAMES, type ErrorName } from "./constants";

export const EXCHANGE_ERROR_MESSAGES: Record<ErrorName, string> = {
  Unauthorized: "This wallet is not allowed to do that.",
  InvalidMint: "A token does not belong to this market.",
  InvalidTokenAccount: "A token account does not belong to this wallet or market.",
  InvalidMintConfig: "The collateral mint is not configured correctly.",
  RoleConflict: "Admin, round controller and oracle must be different wallets.",
  InvalidCoordinates: "The property coordinates are out of range.",
  InvalidTriggerDistance: "The trigger distance must be positive.",
  UnsupportedScenario: "This fire scenario is not supported.",
  ScenarioMismatch: "The property belongs to a different scenario than the round.",
  PreviousRoundOpen: "The previous round is still open.",
  InvalidDeadline: "The trading deadline is invalid.",
  InvalidTimeout: "The resolution timeout is out of bounds.",
  RoundNotOpen: "Trading has closed for this round.",
  TradingEnded: "Trading has closed for this round.",
  RoundNotClosed: "The round has not closed yet.",
  MarketResolved: "This market is already settled.",
  MarketNotResolved: "This market has not settled yet.",
  ResolutionWindowClosed: "The oracle's resolution window has closed.",
  ResolutionWindowOpen: "The oracle's resolution window is still open.",
  InvalidEvidenceHash: "The evidence hash is missing.",
  InvalidOutcome: "Choose YES or NO.",
  InvalidSide: "Choose buy or sell.",
  InvalidPrice: "Price must be between 0.01¢ and 99.99¢.",
  InvalidQuantity: "The quantity is out of range.",
  InvalidExpiry: "The expiry must be in the future.",
  OrderExpired: "That order has expired.",
  OrderNotActive: "That order has already been filled.",
  OrderMismatch: "Those orders cannot be matched.",
  OrderSeqMismatch: "The book changed since your quote. Refresh and try again.",
  OrdersDoNotCross: "Those orders no longer cross.",
  PriceLimitExceeded: "The price moved past your limit. Nothing was traded.",
  SelfTrade: "You cannot trade with your own order.",
  NotSweepable: "That order can't be swept yet.",
  InsufficientPairs: "Not enough YES and NO pairs to merge.",
  LosingOutcome: "These shares did not win.",
  InsufficientFunds: "Not enough balance.",
  MathOverflow: "The amount is too large.",
  NotImplemented: "This action is not available.",
};

export function exchangeErrorName(code: number): ErrorName | undefined {
  return ERROR_NAMES[code - ERROR_CODE_OFFSET];
}

/** Finds the first program error in logs or an error message and returns `Name: plain words`. */
export function describeExchangeError(lines: readonly string[]): string | undefined {
  for (const text of lines) {
    const anchor = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text);
    const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
    const code = anchor ? Number(anchor[2]) : custom ? parseInt(custom[1] as string, 16) : undefined;
    if (code === undefined) continue;
    const name = exchangeErrorName(code);
    if (name) return `${name}: ${EXCHANGE_ERROR_MESSAGES[name]}`;
    return anchor ? `${anchor[1]} (${anchor[2]})` : `custom program error ${code}`;
  }
  return undefined;
}
