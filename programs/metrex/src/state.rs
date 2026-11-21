//! Account layouts (spec §5). FROZEN after Gate 0.

use anchor_lang::prelude::*;

/// Global configuration. Seeds: `["config"]` (§5.1).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub demo_controller: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

/// Admin-registered property. Seeds: `["property", property_id: u16 LE]` (§5.2).
#[account]
#[derive(InitSpace)]
pub struct Property {
    pub property_id: u16,
    /// UTF-8, zero-padded.
    pub label: [u8; 32],
    pub lat_e6: i32,
    pub lon_e6: i32,
    pub scenario_id: u16,
    pub trigger_distance_m: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketStatus {
    Open,
    Closed,
    ResolvedYes,
    ResolvedNo,
    Voided,
}

/// Seeds: `["market", homeowner, market_nonce: u64 LE]` (§5.3).
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub homeowner: Pubkey,
    pub market_nonce: u64,
    pub property_id: u16,
    /// Copied from Property at creation.
    pub lat_e6: i32,
    pub lon_e6: i32,
    pub scenario_id: u16,
    pub trigger_distance_m: u32,
    pub coverage_target: u64,
    /// Sum of accepted offers' coverage.
    pub coverage_activated: u64,
    pub accepted_count: u16,
    pub status: MarketStatus,
    /// Zero until resolved.
    pub evidence_hash: [u8; 32],
    pub created_at: i64,
    pub closed_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum OfferStatus {
    Open,
    Accepted,
    Cancelled,
    Claimed,
    Refunded,
}

/// Seeds: `["offer", market, underwriter, offer_nonce: u64 LE]` (§5.4).
/// Vault seeds: `["vault", offer]` (§5.5).
#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub market: Pubkey,
    pub underwriter: Pubkey,
    pub offer_nonce: u64,
    /// C
    pub coverage: u64,
    /// b
    pub premium_bps: u16,
    /// P = floor(C × b / 10_000), computed on-chain.
    pub premium: u64,
    /// K = C − P, computed on-chain.
    pub collateral: u64,
    /// `Pubkey::default()` until accepted; then the homeowner. Receives the vault on YES.
    pub protection_holder: Pubkey,
    /// `Pubkey::default()` until accepted; then the underwriter. Receives the vault on NO.
    pub risk_holder: Pubkey,
    pub status: OfferStatus,
    pub created_at: i64,
    pub accepted_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Tier 2. Seeds: `["listing", offer, side: u8]` (§5.6).
#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub offer: Pubkey,
    /// 0 = Protection, 1 = Risk.
    pub side: u8,
    /// Must equal the current holder of `side` when listed and when bought.
    pub seller: Pubkey,
    /// mUSD base units the buyer pays the seller.
    pub price: u64,
    pub created_at: i64,
    pub bump: u8,
}
