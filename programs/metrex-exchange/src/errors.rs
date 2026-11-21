//! Error codes (spec-v2 §6.8). FROZEN at Gate V0: append only, never reorder.

use anchor_lang::prelude::*;

#[error_code]
pub enum ExchangeError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Token mint does not match this market or Config")]
    InvalidMint,
    #[msg("Token account owner or address is not the expected one")]
    InvalidTokenAccount,
    #[msg("Collateral mint must have 6 decimals and no freeze authority")]
    InvalidMintConfig,
    #[msg("Admin, round controller and oracle must be distinct, non-default keys")]
    RoleConflict,
    #[msg("Latitude or longitude out of range")]
    InvalidCoordinates,
    #[msg("Trigger distance must be positive")]
    InvalidTriggerDistance,
    #[msg("Scenario is not supported")]
    UnsupportedScenario,
    #[msg("Property scenario does not match the round")]
    ScenarioMismatch,
    #[msg("The previous round is still open")]
    PreviousRoundOpen,
    #[msg("Trading deadline is invalid")]
    InvalidDeadline,
    #[msg("Resolution timeout is out of bounds")]
    InvalidTimeout,
    #[msg("Round is not open")]
    RoundNotOpen,
    #[msg("Trading deadline has passed")]
    TradingEnded,
    #[msg("Round is not closed")]
    RoundNotClosed,
    #[msg("Market is already resolved")]
    MarketResolved,
    #[msg("Market is not resolved")]
    MarketNotResolved,
    #[msg("The oracle resolution window has closed")]
    ResolutionWindowClosed,
    #[msg("The oracle resolution window is still open")]
    ResolutionWindowOpen,
    #[msg("Evidence hash must be non-zero")]
    InvalidEvidenceHash,
    #[msg("Outcome must be 0 (YES) or 1 (NO)")]
    InvalidOutcome,
    #[msg("Side must be 0 (BUY) or 1 (SELL)")]
    InvalidSide,
    #[msg("Price must be between 1 and 9,999 basis points")]
    InvalidPrice,
    #[msg("Quantity is out of range")]
    InvalidQuantity,
    #[msg("Expiry must be zero or in the future")]
    InvalidExpiry,
    #[msg("Order has expired")]
    OrderExpired,
    #[msg("Order has no remaining quantity")]
    OrderNotActive,
    #[msg("Orders do not belong to the same market, outcome or opposite sides")]
    OrderMismatch,
    #[msg("Order sequence does not match the quoted order")]
    OrderSeqMismatch,
    #[msg("Buy price is below sell price")]
    OrdersDoNotCross,
    #[msg("Order price is outside the taker's limit")]
    PriceLimitExceeded,
    #[msg("Maker and taker are the same wallet")]
    SelfTrade,
    #[msg("Order cannot be swept yet")]
    NotSweepable,
    #[msg("Quantity exceeds outstanding pairs")]
    InsufficientPairs,
    #[msg("These shares did not win")]
    LosingOutcome,
    #[msg("Insufficient token balance")]
    InsufficientFunds,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Instruction not implemented in this build")]
    NotImplemented,
}
