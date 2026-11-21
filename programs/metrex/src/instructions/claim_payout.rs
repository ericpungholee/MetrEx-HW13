//! `claim_payout()` (spec §6). YES ⇒ claimant == protection_holder; NO ⇒ claimant == risk_holder.
//! Booked coverage → claimant; any surplus goes to the non-claiming original party (spec §4.4).

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

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, ClaimPayout<'info>>) -> Result<()> {
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
    let amount = offer.coverage;
    let surplus = vault
        .amount
        .checked_sub(amount)
        .ok_or(MetrexError::VaultBalanceMismatch)?;

    // Only a surplus-bearing claim uses a remaining account. The recipient can be
    // provisioned by the fee payer without the other party's signature.
    if surplus > 0 {
        let owner = if claimant == underwriter_key {
            market.homeowner
        } else {
            underwriter_key
        };
        let destination = ctx
            .remaining_accounts
            .first()
            .ok_or(MetrexError::VaultBalanceMismatch)?;
        require!(destination.is_writable, MetrexError::WrongTokenOwner);
        require_keys_eq!(*destination.owner, ctx.accounts.token_program.key(), MetrexError::WrongTokenOwner);
        let token = TokenAccount::try_deserialize(&mut &destination.try_borrow_data()?[..])?;
        require_keys_eq!(token.mint, ctx.accounts.config.mint, MetrexError::WrongMint);
        require_keys_eq!(token.owner, owner, MetrexError::WrongTokenOwner);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: destination.clone(),
                    authority: offer.to_account_info(),
                },
                signer_seeds,
            ),
            surplus,
        )?;
    }

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
