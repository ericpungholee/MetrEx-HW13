// Mirrors programs/metrex/src/errors.rs (spec §6.4). FROZEN after Gate 0. Append only.
// Anchor custom error codes start at 6000.

export const ERROR_NAMES = [
  "Unauthorized",
  "InvalidMarketStatus",
  "InvalidOfferStatus",
  "InvalidBps",
  "CoverageTooSmall",
  "CoverageExceedsTarget",
  "CoverageExceedsRemaining",
  "PremiumRoundsToZero",
  "SelfUnderwriting",
  "WrongMint",
  "WrongTokenOwner",
  "OfferMarketMismatch",
  "NotWinner",
  "InvalidCoordinates",
  "MathOverflow",
  "VaultBalanceMismatch",
  "NotHolder",
  "StaleListing",
  "SelfTrade",
  "InvalidPrice",
  "InsufficientFunds",
  "InvalidSide",
  "InvalidScenario",
] as const;

export type MetrexErrorName = (typeof ERROR_NAMES)[number];

export const ERROR_CODE_OFFSET = 6000;

export function errorCode(name: MetrexErrorName): number {
  return ERROR_CODE_OFFSET + ERROR_NAMES.indexOf(name);
}

export function errorNameOf(code: number): MetrexErrorName | undefined {
  return ERROR_NAMES[code - ERROR_CODE_OFFSET];
}

/** Readable messages for the UI (spec §10.1). */
export const ERROR_MESSAGES: Record<MetrexErrorName, string> = {
  Unauthorized: "Your wallet isn't allowed to do this.",
  InvalidMarketStatus: "This market isn't in a state that allows this action.",
  InvalidOfferStatus: "This offer isn't in a state that allows this action.",
  InvalidBps: "Premium rate must be between 0.01% and 99.99%.",
  CoverageTooSmall: "Coverage is below the 10 mUSD minimum.",
  CoverageExceedsTarget: "Coverage is larger than the amount this market requests.",
  CoverageExceedsRemaining: "This offer exceeds the remaining coverage.",
  PremiumRoundsToZero: "Premium rounds to zero. Increase coverage or rate.",
  SelfUnderwriting: "You can't underwrite your own market.",
  WrongMint: "That token account isn't for mUSD.",
  WrongTokenOwner: "That token account doesn't belong to the expected wallet.",
  OfferMarketMismatch: "That offer belongs to a different market.",
  NotWinner: "Only the winning side can claim this position.",
  InvalidCoordinates: "Coordinates or trigger distance are out of range.",
  MathOverflow: "Amount is too large.",
  VaultBalanceMismatch: "Escrow balance doesn't match. Nothing was moved.",
  NotHolder: "Your wallet doesn't hold this side of the position.",
  StaleListing: "This listing is out of date: the seller no longer holds that side.",
  SelfTrade: "You can't buy a side you already hold or are selling.",
  InvalidPrice: "Price must be greater than zero.",
  InsufficientFunds: "Not enough mUSD in your wallet.",
  InvalidSide: "Side must be Protection or Risk.",
  InvalidScenario: "The settlement oracle does not support this scenario.",
};
