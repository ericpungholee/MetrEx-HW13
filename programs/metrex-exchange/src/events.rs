//! Events (spec-v2 §6.9). FROZEN at Gate V0.

use anchor_lang::prelude::*;

#[event]
pub struct RoundCreated {
    pub round: Pubkey,
    pub round_id: u64,
    pub scenario_id: u16,
    pub dataset_sha256: [u8; 32],
    pub trading_ends_at: i64,
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub round: Pubkey,
    pub property_id: u16,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct SharesSplit {
    pub market: Pubkey,
    pub holder: Pubkey,
    pub quantity: u64,
    pub amount: u64,
}

#[event]
pub struct SharesMerged {
    pub market: Pubkey,
    pub holder: Pubkey,
    pub quantity: u64,
    pub amount: u64,
}

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub order: Pubkey,
    pub maker: Pubkey,
    pub outcome: u8,
    pub side: u8,
    pub price_bps: u16,
    pub quantity: u64,
    pub seq: u64,
    pub expires_at: i64,
}

#[event]
pub struct OrderFilled {
    pub market: Pubkey,
    pub outcome: u8,
    /// `Pubkey::default()` when the buyer was a direct taker.
    pub buy_order: Pubkey,
    /// `Pubkey::default()` when the seller was a direct taker.
    pub sell_order: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub quantity: u64,
    pub price_bps: u16,
    pub quote_amount: u64,
    pub buyer_refund: u64,
    /// The older (resting) order whose price applied.
    pub maker_order: Pubkey,
}

#[event]
pub struct OrderCancelled {
    pub market: Pubkey,
    pub order: Pubkey,
    pub maker: Pubkey,
    pub swept: bool,
    pub remaining_qty: u64,
    pub returned_amount: u64,
}

#[event]
pub struct RoundClosed {
    pub round: Pubkey,
    pub closed_at: i64,
    pub by_controller: bool,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub round: Pubkey,
    /// 1 Yes, 2 No, 3 Invalid.
    pub outcome: u8,
    /// `PATH_ORACLE`, `PATH_EMERGENCY` or `PATH_EXPIRY`.
    pub path: u8,
    pub evidence_hash: [u8; 32],
    pub reason: u8,
}

#[event]
pub struct SharesRedeemed {
    pub market: Pubkey,
    pub holder: Pubkey,
    pub outcome: u8,
    pub quantity: u64,
    pub payout: u64,
}
