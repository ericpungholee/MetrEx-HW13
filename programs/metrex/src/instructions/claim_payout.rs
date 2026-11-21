//! `claim_payout()` (spec §6). YES ⇒ claimant == protection_holder; NO ⇒ claimant == risk_holder.
//! Full vault → claimant; vault closed (rent → original underwriter); Offer → Claimed.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::MetrexError, events::PayoutClaimed, state::*};

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    pub claimant: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [
            OFFER_SEED,
            offer.market.as_ref(),
            offer.underwriter.as_ref(),
            &offer.offer_nonce.to_le_bytes(),
        ],
        bump = offer.bump,
        has_one = market @ MetrexError::OfferMarketMismatch,
        has_one = underwriter @ MetrexError::Unauthorized,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, offer.key().as_ref()],
        bump = offer.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = claimant_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = claimant_token.owner == claimant.key() @ MetrexError::WrongTokenOwner,
    )]
    pub claimant_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: receives the vault's rent on close; must equal `offer.underwriter` (has_one above).
    #[account(mut)]
    pub underwriter: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimPayout>) -> Result<()> {
    let market = &ctx.accounts.market;
    let offer = &ctx.accounts.offer;
    let claimant = ctx.accounts.claimant.key();
    // Claims go to the current holder of the winning side (invariants 11, 14).
    let winner = match market.status {
        MarketStatus::ResolvedYes => offer.protection_holder,
        MarketStatus::ResolvedNo => offer.risk_holder,
        _ => return err!(MetrexError::InvalidMarketStatus),
    };
    require!(
        offer.status == OfferStatus::Accepted,
        MetrexError::InvalidOfferStatus
    );
    require!(claimant == winner, MetrexError::NotWinner);
    let vault = &ctx.accounts.vault;
    require!(vault.mint == ctx.accounts.config.mint, MetrexError::WrongMint);
    require!(vault.owner == offer.key(), MetrexError::WrongTokenOwner);

    let market_key = offer.market;
    let underwriter_key = offer.underwriter;
    let nonce_bytes = offer.offer_nonce.to_le_bytes();
    let bump = [offer.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        OFFER_SEED,
        market_key.as_ref(),
        underwriter_key.as_ref(),
        &nonce_bytes,
        &bump,
    ]];
    // §4.4: an Accepted vault holds exactly C; the full balance goes to the winner.
    let amount = vault.amount;

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.claimant_token.to_account_info(),
                authority: ctx.accounts.offer.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.underwriter.to_account_info(),
            authority: ctx.accounts.offer.to_account_info(),
        },
        signer_seeds,
    ))?;

    let offer = &mut ctx.accounts.offer;
    offer.status = OfferStatus::Claimed;

    emit!(PayoutClaimed {
        market: market_key,
        offer: offer.key(),
        claimant,
        amount,
    });
    Ok(())
}
