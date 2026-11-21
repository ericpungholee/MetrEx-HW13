//! `cancel_listing()` (spec §6, Tier 2). Signer must be `listing.seller`; works in every market
//! status. Listing closed (rent → seller).

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [LISTING_SEED, listing.offer.as_ref(), &listing.side.to_le_bytes()],
        bump = listing.bump,
        has_one = seller @ MetrexError::Unauthorized,
        close = seller,
    )]
    pub listing: Account<'info, Listing>,
}

pub fn handler(_ctx: Context<CancelListing>) -> Result<()> {
    // Workstream A (Tier 2 branch).
    Ok(())
}
