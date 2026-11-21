//! Error codes (spec §6.4). FROZEN after Gate 0. Append only: codes are 6000 + index.

use anchor_lang::prelude::*;

#[error_code]
pub enum MetrexError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized, // 6000
    #[msg("Market is not in a status that allows this action")]
    InvalidMarketStatus, // 6001
    #[msg("Offer is not in a status that allows this action")]
    InvalidOfferStatus, // 6002
    #[msg("Premium rate must be between 1 and 9,999 bps")]
    InvalidBps, // 6003
    #[msg("Coverage is below the minimum")]
    CoverageTooSmall, // 6004
    #[msg("Coverage exceeds the market's coverage target")]
    CoverageExceedsTarget, // 6005
    #[msg("Accepting this offer would exceed the remaining coverage")]
    CoverageExceedsRemaining, // 6006
    #[msg("Premium rounds to zero")]
    PremiumRoundsToZero, // 6007
    #[msg("The homeowner cannot underwrite their own market")]
    SelfUnderwriting, // 6008
    #[msg("Token account has the wrong mint")]
    WrongMint, // 6009
    #[msg("Token account has the wrong owner")]
    WrongTokenOwner, // 6010
    #[msg("Offer does not belong to this market")]
    OfferMarketMismatch, // 6011
    #[msg("Only the winning side can claim")]
    NotWinner, // 6012
    #[msg("Coordinates or trigger distance out of range")]
    InvalidCoordinates, // 6013
    #[msg("Arithmetic overflow")]
    MathOverflow, // 6014
    #[msg("Vault balance does not match the expected amount")]
    VaultBalanceMismatch, // 6015
    #[msg("Signer does not hold this side of the position")]
    NotHolder, // 6016
    #[msg("Listing seller no longer holds this side")]
    StaleListing, // 6017
    #[msg("Buyer cannot be the seller or the opposite-side holder")]
    SelfTrade, // 6018
    #[msg("Price must be at least 1 base unit")]
    InvalidPrice, // 6019
    // --- v1.1.1 additions ---
    #[msg("Insufficient mUSD balance")]
    InsufficientFunds, // 6020
    #[msg("Side must be 0 (Protection) or 1 (Risk)")]
    InvalidSide, // 6021
}
