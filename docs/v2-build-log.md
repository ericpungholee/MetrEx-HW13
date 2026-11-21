# MetrEx v2 — Build log (Gates V0–V6)

_Detailed results for each v2 gate, moved here from [STATUS.md](STATUS.md) on 2026-11-21. Current state, open items and owner decisions live in STATUS.md. The Devnet deployment record is [v2-devnet-verification.md](v2-devnet-verification.md)._

## V0 — Freeze

**Passed 2026-11-21.** `programs/metrex-exchange` compiles with every §6.6 context. IDL `target/idl/metrex_exchange.json` committed: 16 instructions, 5 accounts, 10 events, 38 errors. `@metrex/exchange` (constants, PDAs, math, ladder, book) has 20 tests, including the IDL sync.

## V1 — Binary tokens

**Passed 2026-11-21.** Config, property, round, market, split, merge, the three settlement paths and redeem are implemented. `tests/exchange.ts` has 36 tests, with `assertMarketInvariants` (I1, I2, I5) after every state change. I1, I2 and I5–I9 have named tests, and YES, NO and Invalid conservation pass. The 78 v1 tests still pass.

### V1 build notes

- The order instructions (`place_order`, `take_order`, `match_orders`, `cancel_order`, `sweep_order`) have their frozen account contexts. Their bodies return `NotImplemented` until V2, and a test checks this.
- `Cargo.lock` pins `blake3 = 1.8.2`. 1.8.7 pulls a crate that needs edition 2024, which platform-tools Rust 1.84 can't parse. Build with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`.
- `anchor-spl` needs the `token_2022_extensions` feature for `init_if_needed` ATAs to compile.
- The Anchor test glob is quoted (`'tests/*.ts'`). Unquoted, the shell expanded `tests/**/*.ts` to `tests/helpers/invariants.ts` only, and mocha then ran 0 tests with exit code 0.
- Spec corrections after the freeze are in spec-v2 §0.2: the skew sign and the respect rule (both bot policy), and the timeout bounds wording. No interface changed.

## V2 — Trading protocol

**Passed 2026-11-21.** `place_order`, `take_order`, `match_orders`, `cancel_order` and `sweep_order` are implemented against the frozen contexts. The IDL is unchanged. `tests/exchange.ts` now has 67 tests: 31 for V2, including I3, I4 and I10–I12, the §11 demo replay and the size test. A mutation check, with the execution price forced to the SELL price and the take self-trade check removed, fails 5 of them. R checklist: all six items pass (see below).

- **Demo replay on-chain.** The presenter's market buy of 300 YES fills A 200 @ 430 and B 100 @ 500 for exactly 13.6 mUSD. The sell of 200 @ 410, sent as `place_order` + `match_orders` in one transaction, fills 100 against Bot C for 4.1 mUSD and rests 100. Bot B's 400 bid then returns `OrdersDoNotCross`.
- **Size.** A 4-level take is 1,106 B and about 109k CU. A place + 3-match limit order is 1,181 B and about 114k CU. Both are under 1,232 B and the default compute budget, with every event parsed. The limit order has only 51 B of headroom, so clients should not add a compute-budget instruction to it.
- **R checklist (build-plan-v2 §4), all pass:**
  - Token accounts are bound to the market, order or escrow by PDA seeds, `has_one`, canonical ATA addresses, and handler mint checks against the order's side and outcome.
  - Fills pay `quote(fill, price)` from booked state.
  - Every trading instruction checks the round and the market first.
  - `take_order` checks `expected_seq` and the taker's limit, and fills `min(requested, remaining)`.
  - Cancel and sweep send the whole escrow to the maker's ATA and the rent to the maker.
  - Market and Round are read-only in `take_order` and `match_orders`.
- **Client note.** `match_orders` needs the buyer's canonical mUSD ATA even when the refund is zero (spec-v2 §0.2). Clients prepend an idempotent ATA create.

## V3 — Engine and liquidity (local)

**Passed 2026-11-21.** `scripts/v3-local.sh` passes end to end on a disposable validator (results below). Workspace tests: exchange 33, geo 35, server 50, bots 38, scripts 5, app 13, shared 12. App build passes with the v1 pages unchanged. `anchor test`: 145 passing (67 v2, 78 v1). Program and IDL unchanged.

### Results

Run with `bash scripts/v3-local.sh`. It uses throwaway keys in a temp dir (never `~/.config/metrex`), a fresh `solana-test-validator` with `metrex_exchange.so` upgradeable by the temp admin, and `--timeout 120` for the local round. Devnet setup refuses a timeout under 86,400 s.

- **Bots quote within 10 s, never cross.** After `create_market`, three bots quoted both books of both markets in 5.7 s (featured) and 7.7 s (other), and the §8.3 ladder was exact on YES with exact NO complements. Twenty samples over 10 s showed all 12 bot levels and no cross.
- **§11 demo replay through the planners.** A market buy of 300 YES filled A 200 @ 430 + B 100 @ 500 = 13.6 mUSD in one signature. The limit sell 200 @ 410 (place + match) filled 100 against C for 4.1 mUSD and rested 100. After the bots requoted, the best bot bid was 409.
- **Keeper.** A crossing BUY 20 @ 415 placed with no match was matched once by the keeper at the older price 410, with a 0.01 mUSD refund. One `OrderFilled`, no double match.
- **Restart and dedup.** Two fresh loaders rebuilt an identical book fingerprint (13 orders) and identical trade indexes (4 fills). Unit tests cover event dedup across overlapping pages and restarts.
- **Keeper stopped.** With the keeper killed for 22 s, `handleBook`, `handleMarket` and `handleHealth` kept working, and health reported matching "paused".
- **Settlement.** The second `prepare-demo-v2` run found round 1 stale (two non-bot wallets), closed it, resolved both markets through the oracle (round gate and dataset hash checked), swept, then opened round 2 with fresh markets and bots quoting. Property 1 resolved YES, property 2 NO, and both evidence v2 hashes matched on-chain. A take on the closed round was rejected. The presenter redeemed 180 YES for exactly 180 mUSD.
- **Failures logged.** One bot cancel raced a keeper sweep (`AccountNotInitialized`). The keeper logged none.

### Notes

- **v2 bots** live in `services/bots/src/v2/` (`pnpm --filter bots start:v2`). The v1 bots are untouched for the fallback demo. The keeper and trade index are `services/indexer/src/v2.ts` (`start:v2`, `KEEPER_DISABLED=1` stops matching).
- **Oracle isolation.** Bots and keeper import only `@metrex/server/exchange`, which never reaches oracle or geo code. Tests enforce this, and both workers refuse to start when `METREX_ORACLE_DATA_DIR` is set.
- **Heartbeats** are files in `METREX_HEARTBEAT_DIR` (default `<repo>/.metrex/heartbeat`, gitignored). They are stale after 20 s. On a hosted deploy the app and workers must share this directory, or V4/V5 needs another channel.
- **Routes.** The §7.5 handlers are in `packages/server/src/routes/exchange.ts`, mounted at `app/app/api/{rounds,markets,health}`. Since V5, `/api/evidence` serves v2 markets too (it dispatches on the account owner).
- **Local finality** lags about 13 s. Pre-checks in `prepare-demo-v2` read at `confirmed`, and round creation and settlement wait for `finalized`.
- `app/next.config.ts` adds `@metrex/exchange` to `transpilePackages`, because the server root now imports it.

## V4 — Devnet

**Passed 2026-11-21.** Deployed at `BrHisWF8…Fko`, admin is upgrade authority, dumped bytes match the tested build. Every §13.3 item passed on Devnet, NO validated separately. See [v2-devnet-verification.md](v2-devnet-verification.md).

The full record is [v2-devnet-verification.md](v2-devnet-verification.md).

- **Funding:** 20 Devnet SOL from DevnetFaucet.org (needed the owner's X follow and post).
  - Rate-limited: faucet.solana.com (2 per 8 h) and Pine Stake (cooldown).
  - Needed a Mainnet SOL balance: QuickNode and Chainstack.
- **Deploy:** about 7.7 SOL at peak, 3.84 SOL locked. Program `BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko`, upgrade authority admin, dumped SHA-256 `b9d0325e…` equal to the tested build. v1 is untouched.
- **Config:** uses the existing mUSD mint with a resolution timeout of 86,400 s. Properties 1–3 are registered.
- **§13.3:** every item passed on Devnet (`scripts/prove-v4-devnet.ts --phase trade|settled`):
  - split and merge back to the base unit
  - the exact §8.3 bot ladder
  - market buy 300 = 13.6 mUSD
  - limit sell 200 @ 410 with a 100 partial fill
  - cancel returning the escrow and rent
  - NO buy on property 2
  - one close stopping both markets
  - a simulated split rejected with `RoundNotOpen`
  - YES (property 1) and NO (property 2) with evidence v2 hashes matching on-chain
  - redemptions exact: 200 YES → 200 mUSD, 50 NO → 50 mUSD
- **Round 2** (`Crp8ZE8C…`) is open with fresh markets for the demo.

### RPC rate limits (after V4)

RPC rate limits fixed (2026-11-21, after V4). The workers now read the books with batched, cached `getMultipleAccounts` calls, move order scans to the background, and pace requests with `RPC_MAX_RPS=8` and `RPC_MAX_SCAN_RPS=0.5`. On Devnet: 0 × HTTP 429, about 1.5 requests a second per worker, and bot quotes 6–7 s after market creation on the chain clock (previously 14–23 s). See the Risks section of [v2-devnet-verification.md](v2-devnet-verification.md).

## V5 — App replaces v1

**Passed 2026-11-21.** Tag `v1.1-demo` (local, on `47cbda2`). `/` is the exchange and v1 lives at `/v1`. Production build passes, and a fixture build is refused. Every page renders against Devnet and against fixtures. Workstream C acceptance is tested in `app/lib/exchange-client.test.ts`: a market buy and a limit order each build one transaction, and `RoundNotOpen` reads "Trading has closed for this round." Results below.

- **v1 preserved.** Tag `v1.1-demo` (annotated, local, not pushed) marks main at `47cbda2`. The v1 pages moved unchanged to `/v1`, `/v1/market/[id]`, `/v1/portfolio`, `/v1/create` and `/v1/demo`. The nav no longer links them.
- **Pages (§10).**
  - `/` features `Config.latest_round`, and within it `NEXT_PUBLIC_FEATURED_PROPERTY` (default 1).
  - `/market/[id]` has the headline mid or last, the chart (quoted midpoint and trades, from finalized events, with a table view), the YES/NO book with maker labels, a trade panel that previews and simulates before the wallet, the wallet panel (holdings, reserved, cancel, redeem) and settlement (evidence hash recomputed in the browser).
  - `/portfolio` covers the last 3 rounds, `/rounds` the last 10, and `/operator` the Close and settle steps behind the password.
  - All §10.1 texts are on the market page.
- **New routes.**
  - `/api/rpc` is the browser's JSON-RPC proxy. An allowlist keeps the provider key server-side. Exchange scans are refused, and scans of the v1 program alone are forwarded so `/v1` keeps working. Calls are paced like the server's.
  - `/api/orders?maker=` serves a wallet's orders from the shared cached state.
  - `/api/operator/settle-round` runs close, reject, resolve, sweep and status, one step per call.
  - `/api/evidence` dispatches to v2 for exchange markets.
- **Browser RPC.** It defaults to `<origin>/api/rpc`, and `NEXT_PUBLIC_RPC_URL` is now optional (key-free URLs only). The loopback bridge on port 3032 is no longer needed. The app server's `RPC_URL` is the hosted Devnet RPC with `RPC_MAX_RPS=6` and `RPC_MAX_SCAN_RPS=0.5` (ignored `app/.env.local`).
- **Trade history** comes from one index per market (signatures of the market address, about 10 per round on Devnet, not 1,000+ program-wide), decoded newest first. Until a market's backfill is decoded, the API returns `indexing: true` and the UI says "indexing" instead of showing 0 volume or an empty chart.
- **Older rounds** derive their market PDAs from the known property ids instead of scanning. Fully settled rounds are cached for good.
- **Tests:** exchange 33, geo 35, server 56, bots 39, scripts 5, app 18, shared 12. `anchor test` was not rerun, because no program or IDL changed.

**V5 gaps (not blocking):**
- Portfolio has no "completed redemptions" history (§10.5). Only claimable amounts are shown.
- `/v1` loads in about 20 s through the proxy, because its account scans are paced at 0.5/s for the hosted tier.
- The first visit to an older round costs one property scan (about 10 s cold).
- The faucet button is still the v1 faucet. It mints the same mUSD, which v2 uses.

## V6 — Phantom rehearsal

**Passed 2026-11-21.** Rounds 10 and 11 both completed the Phantom flow and live rejection with a combined sweep and redeem. Round 10 matched §11 exactly. The owner accepted round 11 with a 200-share, single-level buy.

Chronological log of rounds 8–11. Rounds 8 and 9 exposed a bot requote race and a proof-script transport issue, both fixed before round 10. Round 10 matched §11 exactly. Round 11 used an owner-approved 200-share, single-level buy.

- V5 rechecked on 2026-11-21. The local `v1.1-demo` tag is on `47cbda2`. The production build, fixture guard, workspace type checks and 198 TypeScript tests passed. `anchor test --skip-build` passed all 145 local tests (67 v2, 78 v1). The production homepage and `/v1` loaded, and an unauthenticated operator request returned HTTP 403.
- `prepare-demo-v2.ts` reused fresh Devnet round 8 (`5pJV9LK9Pg4brgRNJPZcqtrsaR1iTjxjbC5WDEGiMn64`). Both markets have three bots quoting YES and NO. The Home #1042 ladder matches §8.3. Bots, keeper and presenter passed the funding checks. Both worker heartbeats were current, and the private oracle dataset matched the round commitment.
- The production rehearsal server runs locally on port `3015` with `METREX_ORACLE_DATA_DIR` pointing at the private dataset. [Featured market](http://localhost:3015/market/6DZYdLyF9fDitjXCkpnWfjkYqVP1Fg66P3bcbcgetdvr) · [Operator](http://localhost:3015/operator).
- Chrome rendered the live books and previewed 300 YES for 13.60 mUSD. The order book now exposes Devnet Explorer links under each level's maker labels, and the best ask opened the corresponding on-chain order. Clicking a level's price still populates the limit order ticket.
- Run 1 uses the presenter’s connected Phantom wallet `Bzcf7kHiEAa8hRAqAVTidG9eyN8eUXocZKRvuFjniMvX`. It held 34,705 mUSD, and the faucet topped it up to 0.05 Devnet SOL. Replaced the wallet reader’s Node-only global `Buffer` access with `DataView`. The rebuilt production app shows the correct balance and enables the staged 300 YES buy for 13.60 mUSD in Chrome. [Devnet fee balance top-up](https://explorer.solana.com/tx/5BQNN8ytUZsd5Vcrfp8vhXGfwS9JFgje8k8uqNSSRH6podjZPcp7QiPU8KMsUk2Kw8ovAXwtf7QukAzbajKegPZA?cluster=devnet)
- Run 1 market buy finalized at Devnet slot `524747942`. One Phantom transaction bought 200 YES at 430 bps and 100 YES at 500 bps for 13,600,000 mUSD base units. Chrome showed 300 YES and 34,691.40 mUSD available afterward. The limit sell is staged for 200 YES at 410 bps with 100 filling immediately and 100 resting. Its Phantom signature is pending. Round 8’s trading deadline is November 22 at 8:31 a.m. EST. [Finalized buy](https://explorer.solana.com/tx/4eBkFe6JM6qfY7KAqkWwWie2XeKdvC9Uyp7LkC88YKABJ8SbmSRTsnKZqbar5CxcfXX7tYcCBJkLbcoB9uzdPtRS?cluster=devnet)
- The Phantom limit sell matched 100 YES at 410 bps for 4.10 mUSD and initially rested 100. The keeper matched that remainder at 410 bps in slot `524748335`, 29 slots after the sell transaction. The presenter therefore held 100 winning shares at settlement, and the run did not reproduce the §11 wallet sweep and 200 mUSD claim. Investigate the crossing requote before counting a successful §11 replay. [Phantom sell](https://explorer.solana.com/tx/4mfLVFgnAXq6p7U1ogxyPNtFUesk9aCZNpdJFnS4UQqfJ4KL1cb8epP1FjxbgvrfcNjtMkXhLeo9rg5r8ZxKE8v5?cluster=devnet) · [Keeper match](https://explorer.solana.com/tx/2NKus1DD6JPJddsgXcJF1fPZwrkYDdRtuU52A8k1Yd7Fjws8PCoyijVWKvf9x4fTTPnjy1VaQrPC8NrBk9CiFxdC?cluster=devnet)
- Paused both worker processes before closure and verified Bot A’s 200 YES ask `CQ6dBQ5eNavVUdfio1rLE1jUJZYCc5YB5VU4gkz9b4ab` (seq `13`, 430 bps) had 200 YES in escrow. Closed round 8, submitted a real one-share `take_order` against that order, and observed finalized `RoundNotOpen` (6012) at slot `524748536`. The log read `Instruction: TakeOrder` and `Error Code: RoundNotOpen. Error Number: 6012. Error Message: Round is not open.` No fill event occurred. Order and token account bytes were identical before and after. Escrow YES stayed at `200`, maker mUSD at `245419600000`, taker mUSD at `245613000000`, and taker YES at `1750`, in base units. The only lamport change was the taker’s 5,000-lamport fee. [Finalized close](https://explorer.solana.com/tx/2CQZxHpajfraDUgwTV9aoqtVbBw51Q1GhQziZbpKnSa9nLtCTBnur2Gf88Qwbb4GJqBaRUx2TWDZoUxHMu4hBtyz?cluster=devnet) · [Finalized rejection](https://explorer.solana.com/tx/4W4KAQYyH4Gso5vjrSb8ZFj1rf8WshytDh6JRzza4g7SEgVwniVqTbtnb67ognSDgrbgFyhhkXUqFveejZzmqchh?cluster=devnet)
- Oracle settled both markets. Home #1042 resolved YES with evidence hash `96e3f92f850e40d6b52d77d7a297cd9e1b31c7edc0e095308d740b94081b6c86`. Chrome verified the hash and showed the settled perimeter. Home #2210 resolved NO with hash `2170a7c4f7fbc27a5009355ccd3780ed1a9dfe024b125024453c20d3ca84d730`. Both workers resumed. [YES resolution](https://explorer.solana.com/tx/2RimGwTEdk7ATiBeAkUB4bdp8YjzeUsE5YriWQjAXznGhQZvnnyppBwvUsmzFRjMk3xduyq8uBbXVtLy39UYiyJT?cluster=devnet) · [NO resolution](https://explorer.solana.com/tx/UtHZ3NYm5fWeZas5XXCBqi3jPiUNFFLw2UFV7zfQbmeYgRkAri8AXRjozv1FEDDwyvsMmkBHhf7pfmmo1DFnvn1?cluster=devnet)
- Phantom redemption finalized at slot `524748851`. Transaction metadata shows the presenter’s YES balance changed from `100` to `0` and their mUSD balance rose from `34699600000` to `34799600000` base units, a payout of exactly 100 mUSD. [Finalized redemption](https://explorer.solana.com/tx/2L4H6GaHrHudK2k7c25Wu9gFwUGwC2tYXqhfDCkNJn8AnXavZvGRG7rDAjqmEnTSJobgkXrHiu2W3WmD3yCQjbQe?cluster=devnet)
- Bot C’s crossing bid was placed in slot `524748320`, after the presenter’s sell in `524748306`. The bot worker previously planned against the known orders while the loader scanned for new orders in the background. The worker now holds quotes for a market until the loader reads the newly discovered orders. Restarted the bot worker with the change. Workspace type checks, 56 server tests, and 39 bot tests passed. The next rehearsal must verify the 100 YES remainder survives requotes. [Crossing bid placement](https://explorer.solana.com/tx/4XhBF9pKkdkU9jH65xqS1RFtLzR7Wezo2EZv1EgE7vn1tkup6n44og35f7eQpcAsTpubi2bnYPBW4LkhE2met4qp?cluster=devnet)
- `prepare-demo-v2.ts` created round 9 (`AYvgdaVU8pr8QPMGixNDAEwkGZzwG1UnZBDVJqQ9Qxh3`), verified both books, the exact featured ladder, worker heartbeats and the private dataset hash. The last quotes appeared 10 chain seconds after market creation on both markets. Chrome is connected as `Bzcf…iMvX` with the 300 YES buy staged for 13.60 mUSD on the fresh market. [Round 9 featured market](http://localhost:3015/market/2joUqgM6JHshSiME9FfKrp8TzcZK1FMHBWt5XTpLo62Y)
- Round 9 market buy finalized at slot `524749634`, with 200 YES at 430 bps and 100 YES at 500 bps for exactly 13,600,000 mUSD base units. Chrome previews the follow-up 200 YES sell at 410 bps with 100 filling and 100 resting. [Round 9 finalized buy](https://explorer.solana.com/tx/5ewsGmGYUwEhpZ8Yw24AhP4otgZNp4QXRQ76xLRxz7VWCn3e8gawb3XKqikgX9MEEAC8g6UAn31JK4yNpayYWZFk?cluster=devnet)
- Round 9 Phantom sell finalized at slot `524749875`. It filled 100 YES at 410 bps and left 100 YES in escrow on `GGpY1pc8KCD6p7ak2ktAUxwaVCMUVvWUWsQ8MDMLunSG`. Bot C requoted its bid to 409 bps, so the 100 YES remained through closure. [Sell](https://explorer.solana.com/tx/3CafBRaPCqWzxR2qeBopUFDDjtip3VPSMyqtFZ4cex45J95Nv2maUoZG8kEzVX5eFkJTayQWTn9yTLrDEtaVThD3?cluster=devnet) · [Bot C requote](https://explorer.solana.com/tx/59PjHgH9WhaJPxdcDN4QVxzaZXttPy92uZfZzBVyYV1DhKjg6eNadgz7TSDCwA4SvyW?cluster=devnet)
- Paused both workers, closed round 9, and submitted a live `take_order` against the presenter's preserved order. At finalized slot `524750010` the transaction logged `Instruction: TakeOrder` and `Error Code: RoundNotOpen. Error Number: 6012. Error Message: Round is not open.` No fill or inner instruction ran. Transaction metadata shows identical pre/post token balances: escrow YES `100`, maker mUSD `34790100000`, taker mUSD `245228200000`, and taker YES `1600`. Only the 5,000-lamport taker fee changed. [Close](https://explorer.solana.com/tx/5yNJeLSvhDdCyurFnLy6jhzmPkjFsGSXwi9kCtpDmRx4Xgqmv7uGiwiH4npM37SxCV5J64rn7N4uRTwFF2bAcC58?cluster=devnet) · [Rejection](https://explorer.solana.com/tx/5VewdFGBHTDYuXZPpnEUXauG4Bg6FBsZVeAoF73mNqBXQG1MzCUJdvduqUPoVC3mx3oZEHDhPnffhnKjmPFt8Mjf?cluster=devnet)
- The confirmation subscription reported an error object before the script read the finalized metadata. The failure cleanup resumed the workers, and the keeper returned the 100 escrowed shares in slot `524750040`, ahead of the Phantom claim. The proof script now polls finalized transaction metadata directly. Both markets resolved and the operator reported zero orders. Chrome verified the featured evidence hash `862bf37b682bffbbc93c140d6f4d0fc04c8a88ca06fa705e5584f514f0bcfbb5`, showed the perimeter, and displayed 200 mUSD redeemable. This claim will redeem the shares after a separate keeper sweep. [Sweep](https://explorer.solana.com/tx/3RNk3wqqEDQsCNmPFXBBELTmWTEwnnvGWp5E5T2nb4pQSLbMoAw3vqW8ZEdfiKGRzVHJuwdksdWnWx3y1RHZB2s4?cluster=devnet) · [YES resolution](https://explorer.solana.com/tx/gahusYhVwXeSnpBwgWJdvKYBm4H2ijk6vnkz42iJMBMX4P1Dvv3SThEgynr3SYjdwF5A1URZF3Venqkw1NgG1mo?cluster=devnet) · [NO resolution](https://explorer.solana.com/tx/WRTWLdysY19akqytPMUhG5EcZNwry9k8fWPNeQQx1F3VLumDZruQsqB8aNYy4x4C7wd6mYiDG3QqhsytpHGo6JR?cluster=devnet)
- Round 9 Phantom redemption finalized at slot `524750364`. Transaction metadata shows 200 YES burned and mUSD rising from `34790100000` to `34990100000` base units. For the next replay, leave the keeper paused until Phantom confirms the combined sweep and redeem. If the rejection proof's transport fails, recover its finalized metadata while the keeper remains paused. [Round 9 finalized redemption](https://explorer.solana.com/tx/4CSfr8pi8qe2V1wwLsrwfXwxjjPWcbz72vW53XqfG2C8zCHy34JBztebWCPVN9XD4GstEHH7Wino6iQFsBXkqXZf?cluster=devnet)
- `prepare-demo-v2.ts` created round 10 (`8eWcYv4fQwCwYyUPfE6BkrDEY5Yvy8hLhTrQGw4LYJS9`) and verified the featured ladder, both books, worker heartbeats, and the private dataset. The Phantom buy finalized at slot `524750829`: 200 YES at 430 bps plus 100 YES at 500 bps for 13,600,000 mUSD base units. The sell ticket is staged at 200 YES and 410 bps, with 100 filling and 100 resting. [Round 10 finalized buy](https://explorer.solana.com/tx/2ajebSr6Bp9q819esfbmPHoSeETHHQ7jPkVx1rHU27YT16n1B3SdZf3UKxAbJMyBNAeGmpRZXmkuf8TjRTgpbZG1?cluster=devnet)
- Automated CLI checks ran with throwaway keys on disposable validators. The existing V3 suite completed, including uncrossed requotes and matching once. Its post-sweep simulation hit `OrderMismatch`, so it is not evidence for the closure guard. A separate exact-flow run preserved the resting 100 YES through closure, submitted a real local `take_order` that finalized with `RoundNotOpen` (6012) and unchanged token balances, verified both oracle outcomes and the YES evidence hash, then executed `SweepOrder` and `Redeem` in one signed transaction. The order closed, the wallet’s YES balance went to zero, and it received exactly 200,000,000 mUSD base units. These automated transactions use a local signer. The prior Devnet rejections and Phantom receipts are recorded above. Round 10 remained open for the browser replay.
- Round 10 sell filled 100 YES at 410 bps and left 100 YES in escrow on `J8YXMMZyUkFu3QirZhiwjCH7JrvLqHpRkbjsKyTdMxLZ`. Bot C requoted to 409 bps before closure. The preserved order was the target of a finalized Devnet `TakeOrder` at slot `524752744`. Logs say `Error Code: RoundNotOpen. Error Number: 6012. Error Message: Round is not open.` No fill ran. Order and token account bytes were unchanged, with escrow YES `100`, maker mUSD `34980600000`, taker mUSD `245036800000` and taker YES `1600`. Only the 5,000-lamport fee changed. [Sell](https://explorer.solana.com/tx/5EpcT6x1oGsF9DDdcoysjuEEDLqPzG5t9mYxWxVBEMfL6em5oyanr771gGDEBrcVnNoBqFHaWUttb6kgbiXrMoV5?cluster=devnet) · [Close](https://explorer.solana.com/tx/5HTepgNrQsLLkmp7M4yJXZ7E1FAPeaPuxxabgCxjtTWmVjj88RrxhadkATndUVG9q2euraDjcAA9H3duj3qeWfBG?cluster=devnet) · [Rejection](https://explorer.solana.com/tx/5eKQ4boUcvBbvghTjgdVNtdeLc5xEcg82vq6ZD6w7W3TB5R7iU4PjShK69Goxc2EtjsBUcaPCKJ8KdcT38PG9vuT?cluster=devnet)
- Both round 10 markets resolved, and Chrome verified the featured evidence hash and showed the perimeter. The wallet panel showed 200 mUSD redeemable and one resting order to return. [YES resolution](https://explorer.solana.com/tx/4G3QCGdf6g93cS2EtY3ZYstwXDaLf6vqh9KhF5kKDUksS9kzgCYqBzWyCkPHxceXRjmaX6rMrgZYRj4DgCxrmZNu?cluster=devnet) · [NO resolution](https://explorer.solana.com/tx/2M6Qh91vjafsWUgopiF73z2oRv5pD5UZUofqhqmBLKG7DVneXTRYbjJNyf8i1T7oKHx8NWNj7vwaPhMqip8id95t?cluster=devnet)
- Round 10 passed the complete Phantom rehearsal. One transaction finalized at slot `524752985` with both `SweepOrder` and `Redeem`. It closed the presenter's resting order, consumed the 100 YES from escrow plus 100 YES in the wallet, and raised the wallet's mUSD balance from `34980600000` to `35180600000` base units. The keeper resumed after finalization. [Finalized combined Phantom claim](https://explorer.solana.com/tx/5WKqfsPS5CswfLV1WDnqAMETAnUNakxfUZgnmvo8cTdkQH3k3Wo1rpwigq4ULcfS5yusWmpyzhStV5VjJ2N68xEQ?cluster=devnet)
- Operator completeness for round 10 returned two resolved markets and zero remaining orders. `prepare-demo-v2.ts` created round 11 (`HvNTfEuEcDUtbXyhBs6H8fU7nUmUmgXZUTqaQmUv9RR`) and verified the live ladders, both worker heartbeats and the private dataset. Chrome has the final rehearsal's 300 YES buy staged at 13.60 mUSD. [Round 11 featured market](http://localhost:3015/market/8MrtZy434Yf8YAY7robJn2EN9FGkCozYjxm4gW2kGPXC)
- Round 11’s submitted ticket was set to 200 shares. The market buy finalized at slot `524753428`, filling 200 YES at 430 bps for 8,600,000 mUSD base units. The signed buy differs from the 300-share, two-level §11 beat. [Round 11 finalized buy](https://explorer.solana.com/tx/2kiVyXNUrANKAvMfy62SgrGFjHUY5UvEgkJiUCg4ggBjMDzR1EMfMuQA3m7Movdxwb34AupDVHW8WsCwkp1RgE2b?cluster=devnet)
- Round 11’s sell filled 100 YES at 410 bps and left 100 in escrow on `EZn1bBuahc6UdQXSuGohDL1Dg6gKta8v45ngooqku51B`. Paused both workers and closed the round. A real Devnet `TakeOrder` on the preserved order finalized at slot `524753973` with `RoundNotOpen` (6012). No fill occurred. The order and token account bytes were unchanged. Escrow YES stayed at `100`, maker mUSD at `35176100000`, taker mUSD at `244845400000` and taker YES at `1600`. Only the taker's 5,000-lamport fee changed. [Sell](https://explorer.solana.com/tx/3jjmFUu5BNeRWb6FpiHxhNtqegufFoGz2x2oovs7stvaH858VKdfnHQ92owwhg9PwDQT74peRXCSPMZxKSHWc13F?cluster=devnet) · [Close](https://explorer.solana.com/tx/DJpQYtMsWj1nfzcAbVG5tYZpyWM2rHT1GHChTcuszVQbiXBtTvZ4JqUzpTsFMTwchAJM9UDmkHs662kSqVf7Cvr?cluster=devnet) · [Rejection](https://explorer.solana.com/tx/3tcSFd2WLUTdvtnVhYdDCZNWfueGhs9DoosNPpGB3fjZwRNUsDQKjGkXDKn92BiqqetaU4CDDKt2jW5VKTVk7e22?cluster=devnet)
- Both round 11 markets resolved. Chrome verified the featured evidence hash `8f72c38aae03efbb80e17115bcea5496cd0fcf3fc55c0e92704eac942d5228e3` and revealed the perimeter. The wallet showed 100 mUSD redeemable and one resting order to return. [YES resolution](https://explorer.solana.com/tx/2v8kXiP7ayFiRiBpEKih74NrqwdUiT8RPS9DNFHRysZaH1aNL3knJp1tKx3s32V8gzsRZp4HG9yWUDahgM9MWM9g?cluster=devnet) · [NO resolution](https://explorer.solana.com/tx/638fG57AxD1XVjFjUb86q8zsPi2vujDxiEazkKAHkguR3UYagkRjKAdKApmWGopfUXEiyYm5VkLfSpx13jat2Nev?cluster=devnet)
- Round 11’s combined Phantom claim finalized at slot `524754196` with `SweepOrder` and `Redeem` in one transaction. The resting order closed, the 100 escrowed YES were burned, and the wallet received exactly 100 mUSD (`35176100000` → `35276100000` base units). The keeper resumed, both workers reported healthy, and the operator confirmed two resolved markets with zero orders. [Round 11 combined Phantom claim](https://explorer.solana.com/tx/5AHi2UmR6VfjPXc1rhMb6tvfk6NeeZ1QShJiCJQcxs9TRRN8dr3QRymjCQweUPhMUNdNm8UrmB97iCbAj1fiS6h9?cluster=devnet)
- `scripts/prove-v6-rejection.ts --order <address>` reads the selected order, escrow and both sides' token balances. After finalized closure, `--submit` sends one real Devnet `take_order` and requires finalized `RoundNotOpen` (6012), zero fill events, unchanged order and token accounts, and only the taker's SOL fee in transaction metadata. Record its Explorer link, slot, logs and balances here when it lands.
- Readiness check on round 8 verified 200 YES in escrow for the 430 bps best ask, a funded taker, and the open-round submission guard. The guard refused submission before sending. [Order account on Devnet](https://explorer.solana.com/address/A6uUuRGmK6dMnPMkaXECvijcq3eBVRS3LNwhGEQ37JGg?cluster=devnet)

## Post-V6 quality check (2026-11-21)

Round 10 followed §11 exactly. Round 11 completed the lifecycle with the recorded owner-approved 200-share, single-level buy. Finalized Devnet receipts independently confirm both closure rejections with unchanged token balances and the combined sweep and redemption payouts of 200 and 100 mUSD. Both deployed program binaries match the local builds. The existing PR for this branch is already merged at its v1.1 revision.

The full `anchor test` build and validator run passed all 145 tests (78 v1 and 67 v2). The 198 workspace tests, TypeScript checks, Clippy, production build, fixture guard and disposable-validator V3 replay also passed. The V3 replay's post-sweep rejection was `OrderMismatch`. The finalized Devnet receipts establish `RoundNotOpen`. The production browser loaded both settlement outcomes, the rounds, portfolio and operator pages, and the live v1 fallback. The operator API returned HTTP 403 without a password.

- **Operator settlement (§10.6), fixed.** The workflow requires the API's `roundNotOpen` flag to report a verified closure proof. If the finalized round has no resting orders, it records that the simulation was skipped and continues settlement.
- **Evidence publication (§9.3), fixed.** The settlement panel retries raw evidence every three seconds while publication is pending and links only to browser-verified evidence. Both round 11 markets served hash-matched evidence and perimeters. All eight local V6 evidence records matched finalized market accounts.
- **Wallet redemption (§10.3), deferred for the hackathon.** A wallet with eight resting YES sell orders produced a 1,252-byte claim against the 1,232-byte limit. The one-order demo claim fits and was verified on Devnet. Wallets with larger claims can cancel orders before redeeming.
- **Other quality items.** The portfolio still omits completed redemption history (§10.5). The production npm audit reported seven high and four moderate transitive advisories. Runtime reachability was not established. The Rust lockfile scan flagged two unmaintained crates. RustSec lists locked `borsh` 0.10.4 as patched, and the workspace leaves the logging feature required by the `rand` advisory disabled. [Borsh advisory](https://rustsec.org/advisories/RUSTSEC-2023-0033.html) · [Rand advisory](https://rustsec.org/advisories/RUSTSEC-2026-0097.html)

After the two fixes, all 198 workspace tests, TypeScript checks and the production build passed again. A browser run with stubbed operator responses verified all four proof cases (verified, skipped, unrelated error and successful simulated trade). It also verified that raw evidence retries after an initial HTTP 404 and that a hash mismatch hides the evidence link.


## Multi-peril reliability rehearsal — November 21, 2026

The RFQ runtime was retired and its on-chain program and recovery regressions preserved. A residential audit replaced the former hurricane and earthquake properties. The four market rehearsals used the existing Devnet deployment. Wildfire used Chrome and Phantom, and the other hazards used automated Devnet signers against the live operator API. A separate round verified both Invalid burns. [Market addresses, evidence hashes, exact wallet deltas and receipts](multiperil-verification.md).

The final supervisor restart retained all four new market addresses and their orders. The maker lease refused a second process for the same identities. [Readiness status](STATUS.md).
