//! Events (spec §6.5). FROZEN after Gate 0. The activity feed reads these from logs;
//! account state remains the source of truth.

use anchor_lang::prelude::*;

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub homeowner: Pubkey,
    pub property_id: u16,
    pub coverage_target: u64,
    pub created_at: i64,
}

#[event]
pub struct OfferPlaced {
    pub market: Pubkey,
    pub offer: Pubkey,
    pub underwriter: Pubkey,
    pub coverage: u64,
    pub premium_bps: u16,
    pub premium: u64,
    pub collateral: u64,
}

#[event]
pub struct OfferCancelled {
    pub market: Pubkey,
    pub offer: Pubkey,
    pub underwriter: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct OfferAccepted {
    pub market: Pubkey,
    pub offer: Pubkey,
    pub homeowner: Pubkey,
    pub underwriter: Pubkey,
    pub coverage: u64,
    pub premium: u64,
    pub coverage_activated: u64,
}

#[event]
pub struct MarketClosed {
    pub market: Pubkey,
    pub closed_at: i64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub triggered: bool,
    pub evidence_hash: [u8; 32],
    pub resolved_at: i64,
}

#[event]
pub struct PayoutClaimed {
    pub market: Pubkey,
    pub offer: Pubkey,
    pub claimant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MarketVoided {
    pub market: Pubkey,
}

#[event]
pub struct OfferRefunded {
    pub market: Pubkey,
    pub offer: Pubkey,
    pub homeowner: Pubkey,
    pub underwriter: Pubkey,
    pub premium: u64,
    pub collateral: u64,
}

// --- Tier 2 ---

#[event]
pub struct PositionListed {
    pub offer: Pubkey,
    pub listing: Pubkey,
    pub side: u8,
    pub seller: Pubkey,
    pub price: u64,
}

#[event]
pub struct PositionBought {
    pub offer: Pubkey,
    pub listing: Pubkey,
    pub side: u8,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
}

#[event]
pub struct ListingCancelled {
    pub offer: Pubkey,
    pub listing: Pubkey,
    pub side: u8,
    pub seller: Pubkey,
}
