# MetrEx demo rehearsal

The replay uses the January 2025 Palisades Fire perimeter and the fictional properties in `data/properties.json`. Open by acknowledging the impact of the fire. Explain that the demonstration settles coverage based on fire proximity and show the actual terms on the market page.

## Before recording

- Verify the deployed program ID and that the upgrade authority matches the admin. Verify Config, the classic mUSD mint and properties 1–3 on Devnet.
- Fund the homeowner and judge wallets. Check that each bot has at least 1 SOL and 200,000 mUSD and that the faucet holds at least 5 SOL. Keep an independently verified backup Devnet RPC available.
- Build the app with the Devnet RPC and fixtures off. Enable `NEXT_PUBLIC_ENABLE_TIER2=1` and `BOTS_TIER2=1` after the Gate 5 upgrade.
- Seed and open the fallback market in a second tab. Keep this market available with its three accepted offers.
- Run the YES and NO flows on Devnet on demo day. Save the resulting chain links below before recording.

## Two-minute walkthrough

1. Connect the homeowner wallet. Open Home #1042 with 10,000 mUSD of requested coverage. Point out the historical replay label.
2. Show the three collateralized offers and open one placement transaction in Explorer. At the original rates, the three offers cover 4,000, 3,000 and 3,000 mUSD, with 445 mUSD in premiums and 9,555 mUSD in collateral.
3. Select the three offers and accept them with one signature. Show the activated coverage and the positions table.
4. On the settlement page, close the market, show the 500 m trigger on the map and resolve. Show the browser's evidence hash check.
5. Claim all three YES positions in one transaction. Show the 10,000 mUSD balance increase and link to the claim.
6. For the secondary market, switch to Home #2210. Show the 3.9% judge offer, the requotes and the network panel. Buy a listed Risk position with a judge wallet and show that wallet claiming after a NO resolution.

## Verification and recording

- Stop the bot worker for the manual wallet check. Use a separate judge wallet to place the offer and the homeowner wallet to create, accept and claim. Run `pnpm tsx scripts/prove-lifecycle.ts --manual` for the app-client check with the demo keys.
- Start the bot worker and run `pnpm tsx scripts/prove-lifecycle.ts` for the two core outcomes. Run `pnpm tsx scripts/prove-lifecycle.ts --tier2` once the program supports trading and the Tier 2 worker is running.
- Record the app and wallet confirmations as they happen. Use a public view for the operator panel and hide local key paths and the demo password during recording.
- Rehearse the fallback tab. If a live bot round stalls, open the already funded fallback and continue at settlement. Keep the completed YES and NO recordings available if the RPC becomes unreliable.

## Devnet verification record

| Artifact | Link or record |
|---|---|
| Program | Pending verified deployment |
| Config, mUSD mint and registered properties | Pending provisioning |
| Manual wallet lifecycle | Pending Devnet run |
| YES market, acceptance, resolution, claim and evidence hash | Pending Devnet run |
| NO market, acceptance, resolution, claims and evidence hash | Pending Devnet run |
| Requote, secondary purchase and new holder claim | Pending Devnet run |
| Fallback market | Pending Devnet seed |
| Recording and rehearsal | Pending live verification |
