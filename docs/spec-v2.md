# MetrEx Exchange v2 — Specification

**Hackathon:** Hack Western 13 · **Track:** MLH Best Use of Solana · **Network:** Solana Devnet
**Status:** Proposed. Gate V0 (freeze) has not started. Owner decisions are listed in §15.
**Supersedes:** the v1.1 product ([spec.md](spec.md)) as the user-facing experience. The v1.1 program stays deployed, frozen and unchanged as the fallback demo.
**Demo constraint:** one presenter, one Phantom wallet, four minutes.

> MetrEx is an on-chain exchange for catastrophe risk. Every market asks one binary question about a real place. Two fungible SPL tokens represent the outcomes, each backed by 1 mUSD in a market vault. Traders buy and sell them in a fully escrowed limit order book, and an oracle settles from a fixed historical dataset.

**Guiding principle:** one excellent, liquid, fully working binary exchange. Do not build a broad set of partly working features.

---

## 0. Design review of the v2 draft

The draft's core model works: fungible outcome tokens, split, merge and redeem, an escrowed order book and round-level closure. Each row below is a flaw that would break settlement, the demo or the honesty rules. The fix is part of this spec. Severity: **C** breaks money or settlement, **H** breaks the demo or fairness, **M** creates operational risk, **L** fixes clarity or a bad example.

| # | Sev | Flaw in the draft | Concrete failure | Fix (section) |
|---|---|---|---|---|
| 1 | C | Invariants are written as raw equalities (`vault_balance = YES_supply × 1 mUSD`) | Anyone can transfer 1 base unit into a vault or escrow. Any holder can burn their own SPL shares without a mint authority. An on-chain equality check would then block every redemption. Tests and the bots would also flag a valid market as broken | Book obligations in program state (`pairs_outstanding`). Require `balance ≥ obligation`, never `=`. Payouts use booked amounts and never the raw balance (§4.6) |
| 2 | C | Two Open rounds can share one historical fire | Round A closes and reveals the Palisades perimeter while Round B, on the same fire, still trades. This is the v1.2 cross-market leak, moved up to the round level | At most one Open round at a time. `create_round` requires the previous round to be Closed (§6.3) |
| 3 | C | Settlement depends on the operator staying alive | If the controller never closes or the oracle never resolves, single-side holders are never paid. Recovery depends on the operator | `trading_ends_at` deadline. Anyone can close after it. After `closed_at + resolution_timeout_s` the oracle can no longer resolve, and anyone can invalidate for 0.5 / 0.5 (§6.6, §9.5) |
| 4 | C | Invalidation is a discretionary admin power with no window | After closing, the admin knows the public outcome. It could invalidate a market where the house bots are losing and recover half | Invalidation only after the round is Closed. The admin path stays as a disclosed trusted escape hatch. Resolution and invalidation windows don't overlap, so the timeout path is deterministic (§4.5, §16) |
| 5 | C | Order PDAs keyed by the market's order sequence | Two bots place orders in the same slot, derive the same address, and one fails. This is the v1.0 offer-counter bug again | PDA seeds use a client nonce. The program stores the sequence in the order and never uses it in a seed (§6.5) |
| 6 | C | A taker's quote can be replayed against a replaced order | A maker cancels and re-places at the same PDA (same nonce) at a worse price. The taker's transaction, built from the old book, fills at the new price | `take_order` carries the taker's `limit_price_bps` and `expected_seq`. The fill fails if the order instance or the price differs (§5.7) |
| 7 | C | Token accounts are not bound to the market | A taker passes YES tokens from market A to fill a SELL order on market B | Every token account is constrained to that market's mints, vault or the order's escrow. `order.market == market` (§5.4, invariant I10) |
| 8 | H | The example bot ladder crosses itself | With plausible spreads, for example Bot A at 4.0% ± 0.2, Bot A asks 4.2%. Bot C at 5.0% ± 0.6 bids 4.4%. The keeper matches them forever, which creates house-to-house volume and drains inventory | Bots are post-only against the live book. Each bot derives its NO quotes as exact complements of its YES quotes, which also removes cross-book arbitrage (§8.2) |
| 9 | H | No self-trade rule | One wallet fills its own orders and inflates volume and the chart | `SelfTrade` error in `take_order` and `match_orders` (§5.4) |
| 10 | H | The demo's partial fill depends on an off-chain matcher | If the keeper is slow or down, the "real partial fill" beat fails on stage | A limit order is one transaction: `place_order` followed by `match_orders` against up to 3 crossing resting orders. The presenter's own signature performs the partial fill. The keeper only clears races (§5.5) |
| 11 | H | The chart is empty at 0:00 | The demo uses a fresh round with no trades. Fabricated data is banned, so the opening shot shows nothing | The chart plots confirmed fills plus a best bid, best ask and midpoint history rebuilt from on-chain order events. Both come from real commitments (§7.3) |
| 12 | H | The featured outcome is not pinned | The demo ends by redeeming winning YES. If the featured property settles NO, the presenter redeems nothing | Featured market: Home #1042 (YES). Home #2210 (NO) trades in the same round and gives the independent NO validation (§11) |
| 13 | H | Draft omits the required disclosures | The draft has no trigger sentence, no historical-replay label and no note that the bots are run by MetrEx | §10.1 keeps the trigger sentence, the replay disclosure and the invalid-outcome disclosure, and labels house wallets |
| 14 | H | Bots share `packages/server`, which contains the oracle | The rule against settlement data in trading strategies is only a convention | Enforce it. The bot process refuses to start if `METREX_ORACLE_DATA_DIR` is set, and a test fails if bot code imports `@metrex/geo` or oracle modules (§8.4) |
| 15 | M | A maker can close its receiving token account | Fills to that maker fail and phantom depth sits at the top of the book. Sweeps fail and the escrow is stuck | `place_order` creates the maker's receiving ATA. The indexer hides orders whose receiving ATA is missing. `sweep_order` recreates the ATA, paid by the caller (§5.8) |
| 16 | M | Multi-level fills have no size limit | A large market order exceeds the 1,232-byte transaction or the compute limit and fails without explanation | Up to 4 levels per market order and 3 crossing matches per limit order, enforced by a transaction-size test. The UI shows the unfilled remainder (§5.7) |
| 17 | M | Hot write locks | If fills write Market or Round, every trade on the featured market serializes | Fills and matches read Market and Round without writing them. Only `place_order`, `split` and `merge` write the Market (§6.6) |
| 18 | M | Market creation is unrestricted | Anyone creates duplicate markets for one property and splits liquidity. Nothing ties a property's fire to the round's fire | Only the controller creates markets. PDA `["market", round, property_id]`, with `property.scenario_id == round.scenario_id` (§6.4) |
| 19 | M | The dataset is not committed before trading | The oracle "validates its recorded hash", but nothing on-chain records which file was promised | `create_round` stores `dataset_sha256`. The oracle refuses a dataset that doesn't match the hash (§9.3) |
| 20 | M | Sweeping has no rule for rent | A keeper could route rent to itself, which rewards aggressive sweeping | Rent and every escrowed token always return to the maker (§5.8) |
| 21 | M | Upgrading the v1.1 program in place | Breaks the deployed fallback and mixes two account models in one program | New program `metrex_exchange` with a new program ID. The v1.1 program stays frozen (§14) |
| 22 | M | Repeatability with an aborted rehearsal | The prepare script finds an Open, half-used round and either reuses it or can't create a new one (fix #2) | The prepare script settles any stale Open round first: close, resolve, sweep. Only then does it create a fresh round (§12) |
| 23 | M | Earlier rounds reveal outcomes | The homepage's "other markets" list shows Home #1042 resolved YES from last rehearsal | The homepage shows only `Config.latest_round`. Past rounds are on a separate page labelled with their outcomes (§10.2) |
| 24 | M | Mint freeze authority not checked | A collateral mint with a freeze authority could freeze vaults or escrows | `initialize_config` rejects a collateral mint with a freeze authority. Outcome mints are created with none (§6.1) |
| 25 | L | Example arithmetic is off by 10× | §5.5 says 100 shares at 400 bps pay "40 mUSD". `100 × 400 × 100` = 4,000,000 base units = **4 mUSD** | Corrected in §5.5 |
| 26 | L | "Current price" is undefined | Mid, last trade and best ask give three different headline numbers | Headline = book midpoint when both sides exist and the spread is ≤ 10¢. Otherwise the last fill, otherwise "—". The label says which (§10.3) |
| 27 | L | `split` after close, `merge` after resolution and delegate redemption are not specified | They create extra accounting paths that need tests | `split` requires the round Open. `merge` requires the market Unresolved. Redemption is owner-signed only (§4) |
| 28 | L | Maximum loss for a sale is undefined | For a sale, "maximum loss" has no meaning without a cost basis | Defined per action in §10.4. There is no P&L without a cost basis |

**Product-level tradeoff (not a flaw, flagged for the owner):** v1 was hedger-initiated, and the homeowner created the contract. In v2 the operator lists markets and a homeowner buys YES. Size is preserved, since 1 YES = 1 mUSD of protection. Location was already limited to registered properties. The pitch changes from "list your risk" to "buy protection on a listed risk".

---

## 1. Product

### 1.1 Market question

**Home #1042 — Will the final mapped footprint of the Palisades Fire come within 500 m?**

| Token | Also called | Pays |
|---|---|---|
| YES | Protection | 1 mUSD per share if the trigger is met |
| NO | Risk | 1 mUSD per share if it is not |

Every market page shows, verbatim: *"Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage."*

### 1.2 Principles

1. Every outstanding share is backed by escrowed mUSD.
2. Shares of one outcome in one market are fungible SPL tokens.
3. Every displayed price, level, fill and volume number comes from on-chain orders and fills.
4. Wallets custody their own shares. The service never signs for a user.
5. Settlement follows a predefined geographic trigger on a dataset whose hash is committed on-chain before trading.
6. MetrEx is a risk exchange, not insurance. "Parametric protection" describes the YES side. Nothing here is a licensed policy.

### 1.3 Who uses it

- **Homeowner:** buys YES as gap protection. This is the v1.1 §1.1 story: Palisades non-renewals and the FAIR Plan.
- **Underwriter or market maker:** splits mUSD into pairs, sells YES and keeps NO. This reproduces the v1 underwriting economics (§4.2).
- **Trader:** buys or sells either side before close and exits without the original counterparty's permission.

---

## 2. Scope

**In scope:** binary YES/NO markets; fungible 0-decimal outcome tokens; split, merge, redeem; YES, NO and Invalid settlement; escrowed BUY and SELL limit orders; partial fills; market orders against resting depth; cancel; expiry and sweep; atomic round closure; a keeper and order-book indexer; three market-making bots; an exchange homepage, market page, portfolio and protected operator view; one historical scenario (Palisades 2025); Devnet only.

**Out of scope:** leverage, margin, liquidation; AMMs and pools; on-chain order-book enforcement of price-time priority; complementary "mint/merge" matching across the YES and NO books; trading fees; gasless or session keys; actuarial or ML pricing; live fire data; decentralized oracles; mainnet and real money; P&L and tax accounting; migrating v1.1 positions; token metadata (Phantom may show the shares as unknown tokens; the app shows labels); a database (on-chain reads plus an in-memory cache only); other fires; damage-based triggers; KYC; mobile apps.

---

## 3. Units and prices

| Quantity | Type | Rule |
|---|---|---|
| mUSD | `u64` base units | 6 decimals; 1 mUSD = 1,000,000. The existing Devnet mUSD mint is reused (§14) |
| Shares | `u64` | YES and NO mints have **0 decimals**. 1 share pays 1,000,000 base units on a win and 500,000 on Invalid |
| Price | `u16` basis points | 1 ≤ `price_bps` ≤ 9,999. 400 bps = 0.04 mUSD per share = 4.0¢ |
| Quote amount | `u64` | `quote = quantity × price_bps × 100`, computed in `u128` and checked. No rounding exists anywhere: every quote is an exact integer |

**Constants (program, frozen at V0):**

| Constant | Value |
|---|---|
| `MUSD_DECIMALS` / `MUSD_UNIT` | 6 / 1,000,000 |
| `SHARE_DECIMALS` | 0 |
| `PAYOUT_PER_SHARE` | 1,000,000 |
| `INVALID_PAYOUT_PER_SHARE` | 500,000 |
| `QUOTE_PER_SHARE_BPS` | 100 |
| `MIN_PRICE_BPS` / `MAX_PRICE_BPS` | 1 / 9,999 |
| `MIN_ORDER_QTY` / `MAX_ORDER_QTY` | 1 / 1,000,000 shares |
| `MAX_SPLIT_QTY` | 1,000,000 pairs per call |
| `DEFAULT_TRIGGER_DISTANCE_M` | 500 |
| `SCENARIO_PALISADES_2025` | 1 |

**Client limits (frozen at V0, verified by a transaction-size test):** `MAX_TAKE_LEVELS = 4` per market-order transaction, `MAX_MATCH_LEVELS = 3` per limit-order transaction.

The YES price approximates implied probability. The NO book has its own executable prices. **Never synthesize an executable NO quote from the YES book.** The UI may show the complement only when labelled "indicative".

---

## 4. Collateral and outcome tokens

### 4.1 Split

`split(q)`: transfer `q × 1,000,000` mUSD from the caller to the market vault, mint `q` YES and `q` NO to the caller and set `pairs_outstanding += q`, in one instruction. The market PDA is the sole mint authority. Allowed only while the round is Open, before `trading_ends_at`, and the market is Unresolved.

### 4.2 Underwriting economics (worked example)

An underwriter splits 10,000 mUSD, then sells 10,000 YES at 400 bps to a homeowner for `10,000 × 400 × 100` = 400,000,000 base units = 400 mUSD.

| Outcome | Homeowner (paid 400) | Underwriter (deposited 10,000, received 400) |
|---|---|---|
| YES | redeems 10,000 YES → +10,000 (net +9,600) | NO worthless (net −9,600) |
| NO | YES worthless (net −400) | redeems 10,000 NO → +10,000 (net +400) |
| Invalid | redeems 10,000 × 0.5 = 5,000 (net +4,600) | redeems 5,000 (net −4,600) |

This reproduces the v1.1 offer economics: K = 9,600 collateral and P = 400 premium. Both sides can now be traded freely.

### 4.3 Merge

`merge(q)`: burn `q` YES and `q` NO from the caller (owner-signed), transfer `q × 1,000,000` from the vault to the caller, and set `pairs_outstanding −= q` (checked, `q ≤ pairs_outstanding`). Allowed while the market is Unresolved, including after the round closes. Rejected after resolution: redemption is the only exit then.

### 4.4 Redeem

`redeem(outcome, q)`: the holder signs, `q` of `outcome` tokens are burned from the holder's own account, and the payout goes to the holder's own mUSD account (owner equals the signer). No delegate path exists, and no role can redirect a redemption.

| Market outcome | YES redeems | NO redeems |
|---|---|---|
| Yes | 1,000,000 per share | rejected (`LosingOutcome`) |
| No | rejected | 1,000,000 per share |
| Invalid | 500,000 per share | 500,000 per share |

Partial redemption is allowed. Burning makes double redemption impossible. Losing shares can be discarded with a plain SPL burn, which the program doesn't need to handle.

### 4.5 Invalid

Invalid pays 0.5 mUSD per share to both sides. It is a defined fallback for a market that can't be resolved, not a reversal of trades. Anyone who bought above 0.5 mUSD loses on Invalid. The UI states this beside the trade button. Who can invalidate and when is defined in §6.6 (`invalidate_market`).

### 4.6 Collateral invariants (I1)

The program books obligations. It never trusts raw balances for payouts.

| Market state | Obligation `O` | Required |
|---|---|---|
| Unresolved | `pairs_outstanding × 1,000,000` | `vault.amount ≥ O`; `yes_supply ≤ pairs_outstanding`; `no_supply ≤ pairs_outstanding` |
| Yes | `yes_supply × 1,000,000` | `vault.amount ≥ O` |
| No | `no_supply × 1,000,000` | `vault.amount ≥ O` |
| Invalid | `(yes_supply + no_supply) × 500,000` | `vault.amount ≥ O` |

Supplies equal `pairs_outstanding` and vault equals `O` whenever nobody has self-burned shares or sent unsolicited tokens. Tests assert equality in that case and `≥` in the adversarial cases (unsolicited deposit, holder self-burn). Surplus in a vault is stranded and harmless. It is never paid to anyone. Orders move existing mUSD and shares between participants and escrows and never touch the vault.

---

## 5. Trading

### 5.1 Model

An **escrow-backed limit order book**. Each order is an on-chain account with its own escrow token account. The book is indexed off-chain. Every fill settles on-chain. Price-time priority is **matching-service policy**. The program guarantees collateral, limit-price and quantity correctness, not which eligible counterparty gets filled (disclosed, §16).

### 5.2 Orders

Four combinations per market: BUY or SELL × YES or NO. To bet against YES, buy NO. Selling requires holding the shares: there is no naked short.

| Side | Escrow at placement | Escrow invariant (I3) |
|---|---|---|
| BUY | `quantity × price_bps × 100` mUSD | `escrow.amount ≥ remaining × price_bps × 100` |
| SELL | `quantity` outcome shares | `escrow.amount ≥ remaining` |

Orders are fully backed when placed, so the same funds can never back two orders. An order is **active** when its account exists, `remaining > 0`, it hasn't expired (`expires_at == 0 || now < expires_at`), the round is Open with `now < trading_ends_at`, and the market is Unresolved.

### 5.3 Priority and execution price

Each order gets `seq = market.next_order_seq++` at placement. **Lower seq is older.** When two resting orders cross, they execute at the **older order's price**. A direct taker (`take_order`) always pays or receives the resting order's price.

### 5.4 Fill rules (enforced on-chain)

For any fill of `f` shares:
- Same market and outcome. One side BUY, the other SELL. Both active.
- `buy.price ≥ sell.price`, and the execution price lies within both limits.
- `1 ≤ f ≤ min(requested, remaining of each order)`. The program fills `min(requested, remaining)` and requires at least 1.
- **Self-trade is rejected:** `maker ≠ taker` and `buy.maker ≠ sell.maker` (`SelfTrade`).
- Proceeds go to the counterparties' canonical ATAs for the correct mint (address-derived, owner- and mint-checked).

### 5.5 Matching two resting orders and partial fills

`match_orders(q)`: anyone may submit it. Execution price `x` = the older order's price.

- Sell escrow sends `f` shares to the buyer.
- Buy escrow sends `f × x × 100` to the seller.
- Buy escrow refunds `f × (buy.price − x) × 100` to the buyer as price improvement. This is zero when the buy is older.
- Both `remaining −= f`. Each escrow keeps exactly the reserve for its remaining quantity.

**Worked example (corrected):** Bot A rests BUY YES 100 @ 400 (seq 7). The presenter places SELL YES 200 @ 390 (seq 12) and matches it against Bot A in the same transaction. Execution is at 400, the older price. Bot A receives 100 YES and the presenter receives `100 × 400 × 100` = 4,000,000 = **4 mUSD**, 0.10 mUSD better than the 390 limit. The presenter's order now shows original 200, remaining 100 @ 390, resting.

**Price improvement:** an older bid at 450 against a newer ask at 420 executes at 450, and the seller gets more than asked. An older ask at 420 against a newer bid at 450 executes at 420, and the buyer is refunded 30 bps × 100 per share from escrow.

**Limit orders that cross (client rule).** A limit order is one transaction: `place_order`, then `match_orders` against up to `MAX_MATCH_LEVELS` crossing resting orders in price-time order. The new order is always the younger one, so the resting maker's price applies. The remainder rests. The trade panel previews "fills X now at Y, Z rests at your price" from the live book before signing. The partial fill therefore happens in the presenter's own transaction and does not depend on the keeper.

**Keeper:** clears any crosses left by races between clients (§7.4).

### 5.6 Placement

`place_order(client_nonce, outcome, side, price_bps, quantity, expires_at)` creates the Order and its escrow, escrows the backing, assigns `seq`, and creates the maker's receiving ATA if missing (outcome mint for BUY, mUSD for SELL). Requires an Open round before `trading_ends_at`, an Unresolved market, a valid price and quantity, and `expires_at == 0 || expires_at > now`.

### 5.7 Market orders (direct taker)

`take_order(quantity, limit_price_bps, expected_seq)`: the taker signs and trades directly against one resting order. The taker never creates an order account.

- `order.seq == expected_seq`, or `OrderSeqMismatch`. This pins the exact order instance the client quoted (flaw #6).
- Taker buying from a SELL order requires `order.price ≤ limit`. Taker selling into a BUY order requires `order.price ≥ limit` (`PriceLimitExceeded`).
- Taker buy: the taker pays `f × price × 100` to the maker and the escrow sends `f` shares to the taker. Taker sell: the taker sends `f` shares to the maker and the escrow sends `f × price × 100` to the taker.

Client construction: read the book, pick up to `MAX_TAKE_LEVELS` best levels, set every level's `limit_price_bps` to the user's worst acceptable price (best price ± the visible slippage setting), and request one signature.

**Atomicity and partial results, stated in the UI:**
- If any quoted order was cancelled (account closed) or replaced, the whole transaction fails and nothing moves. The UI refreshes the book, re-quotes once and asks again.
- If a quoted order was partly filled by someone else, that level fills the smaller remaining amount. The user can end up with **less quantity, never a worse price**. The confirmation shows the actual filled quantity from `OrderFilled` events.
- If depth exceeds the level limit, the UI shows "fills X of Y. Submit again for the rest." The UI never promises all-or-nothing across transactions.
- The UI never simulates fills by changing displayed balances. Optimistic rows are marked pending until confirmed.

### 5.8 Cancel and sweep (I11)

Both close the Order and its escrow. The entire escrow balance, including any unsolicited surplus, goes to the maker's canonical ATA. Rent goes to `order.maker`. Executed fills are unaffected. A closed order can't be filled, and a re-created PDA gets a new `seq`.

| Instruction | Who | When |
|---|---|---|
| `cancel_order` | maker | Any time, in any round or market state, including after resolution |
| `sweep_order` | anyone | Round Closed, **or** `now ≥ trading_ends_at`, **or** order expired, **or** `remaining == 0` |

`sweep_order` creates the maker's ATA if the maker closed it, paid by the caller. Recovery therefore never depends on the maker or the operator. Winning shares locked in an old SELL order are recovered by sweeping or cancelling, then redeemed. The client combines both into one transaction.

### 5.9 Trading cutoff

Round Closed, or `now ≥ trading_ends_at`, stops `split`, `place_order`, `take_order` and `match_orders` on every member market. That check is the only lifecycle input to those instructions. `merge`, `cancel_order` and `sweep_order` keep working. Outcome tokens are standard SPL tokens. The cutoff stops MetrEx execution, not peer-to-peer SPL transfers.

---

## 6. On-chain program `metrex_exchange`

New Anchor program in `programs/metrex-exchange/`, pinned to the same toolchain (Anchor 0.32.3, Agave 4.1.2, classic SPL Token). All seeds are listed below, and `u16`/`u64` seed integers are little-endian. Every token account is constrained by mint and authority. All arithmetic is checked. `require!` uses named errors. `unwrap()` is not allowed.

### 6.1 `Config` — `["config"]`

| Field | Type | Notes |
|---|---|---|
| `admin` | Pubkey | Must be the program upgrade authority at init (v1.1 pattern, via `ProgramData`) |
| `round_controller` | Pubkey | Creates rounds and markets and closes rounds |
| `oracle_authority` | Pubkey | Resolves YES or NO. Distinct from the controller and admin |
| `collateral_mint` | Pubkey | 6 decimals, **no freeze authority**, checked at init |
| `latest_round` | Pubkey | `Pubkey::default()` until the first round. The frontend features this round |
| `next_round_id` | u64 | |
| `resolution_timeout_s` | i64 | > 0. Devnet 86,400. The local test validator uses 10 |
| `version` | u8 | 2 |
| `bump` | u8 | |

### 6.2 `Property` — `["property", property_id: u16]`

Same layout as v1.1 §5.2: `property_id`, `label [u8;32]`, `lat_e6`, `lon_e6`, `scenario_id`, `trigger_distance_m`, `bump`. Registered by the admin from `data/DATASET.md` (same three points).

### 6.3 `Round` — `["round", round_id: u64]`

| Field | Type | Notes |
|---|---|---|
| `round_id` | u64 | `config.next_round_id` at creation |
| `scenario_id` | u16 | Must be supported |
| `dataset_sha256` | [u8; 32] | Commitment to the settlement dataset, made before trading |
| `label` | [u8; 32] | e.g. "Palisades replay #4" |
| `status` | enum | `Open`, `Closed` |
| `created_at`, `trading_ends_at`, `closed_at` | i64 | `trading_ends_at > created_at`; `closed_at` 0 until closed |
| `market_count`, `resolved_count` | u16 | For settlement-completeness checks |
| `bump` | u8 | |

**At most one Open round** (flaw #2): `create_round` requires `config.latest_round == default` or the passed `previous_round` (key = `config.latest_round`) to be Closed.

### 6.4 `Market` — `["market", round, property_id: u16]`

One market per property per round.

| Field | Type | Notes |
|---|---|---|
| `round` | Pubkey | |
| `property_id`, `scenario_id` | u16 | `property.scenario_id == round.scenario_id` |
| `lat_e6`, `lon_e6` | i32 | Copied from Property |
| `trigger_distance_m` | u32 | Copied |
| `yes_mint` | Pubkey | PDA `["yes_mint", market]`, 0 decimals, mint authority = market, no freeze authority |
| `no_mint` | Pubkey | PDA `["no_mint", market]`, same |
| `vault` | Pubkey | PDA `["vault", market]`, collateral mint, authority = market |
| `outcome` | enum | `Unresolved`, `Yes`, `No`, `Invalid` |
| `evidence_hash` | [u8; 32] | Zero unless Yes or No |
| `pairs_outstanding` | u64 | `split` adds, `merge` subtracts |
| `next_order_seq` | u64 | |
| `created_at`, `resolved_at` | i64 | |
| `bump`, `yes_mint_bump`, `no_mint_bump`, `vault_bump` | u8 | |

### 6.5 `Order` — `["order", market, maker, client_nonce: u64]`

| Field | Type | Notes |
|---|---|---|
| `market`, `maker` | Pubkey | |
| `client_nonce` | u64 | Client-chosen. Never derived from a shared counter |
| `outcome` | u8 | 0 YES, 1 NO |
| `side` | u8 | 0 BUY, 1 SELL |
| `price_bps` | u16 | |
| `original_qty`, `remaining_qty` | u64 | |
| `seq` | u64 | Priority. Not a seed |
| `expires_at`, `created_at` | i64 | `expires_at` 0 = none |
| `bump`, `escrow_bump` | u8 | |

Escrow: PDA `["escrow", order]`. The token account holds the collateral mint for BUY or the outcome mint for SELL, with authority = order. The status is derived. Cancelled and swept orders no longer exist.

### 6.6 Instructions

Fills and matches take Market and Round **read-only**, so they don't serialize behind each other (flaw #17).

| Instruction | Signer | Preconditions | Effects |
|---|---|---|---|
| `initialize_config(round_controller, oracle_authority, resolution_timeout_s)` | upgrade authority | Config absent; roles distinct and non-default; mint 6 decimals, no freeze authority; timeout > 0 | Create Config |
| `register_property(id, label, lat_e6, lon_e6, scenario_id, trigger_m)` | `admin` | As in v1.1 | Create Property |
| `create_round(scenario_id, dataset_sha256, label, trading_ends_at)` | `round_controller` | No Open round (§6.3); hash non-zero; `trading_ends_at > now` | Create Round (Open); `latest_round = round`; `next_round_id += 1` |
| `create_market()` | `round_controller` | Round Open and `now < trading_ends_at`; Property exists; scenarios match; PDA unused | Create Market, both mints and the vault; `round.market_count += 1` |
| `split(q)` | holder | §4.1 | §4.1 |
| `merge(q)` | holder | §4.3 | §4.3 |
| `place_order(...)` | maker | §5.6 | §5.6 |
| `take_order(q, limit_price_bps, expected_seq)` | taker | §5.4, §5.7 | §5.7 |
| `match_orders(q)` | anyone | §5.4, §5.5 | §5.5 |
| `cancel_order()` | maker | Order exists | §5.8 |
| `sweep_order()` | anyone | §5.8 table | §5.8 |
| `close_round()` | `round_controller` any time while Open; **anyone** once `now ≥ trading_ends_at` | Round Open | Closed; `closed_at = now` |
| `resolve_market(triggered, evidence_hash)` | `oracle_authority` | Round Closed; market Unresolved; `now < closed_at + resolution_timeout_s`; hash non-zero | Outcome Yes or No; store hash; `resolved_at`; `round.resolved_count += 1` |
| `invalidate_market(reason: u8)` | `admin` once the round is Closed, **or anyone** once `now ≥ closed_at + resolution_timeout_s` | Round Closed; market Unresolved | Outcome Invalid; `round.resolved_count += 1` |
| `redeem(outcome, q)` | holder | Market resolved; §4.4 | §4.4 |

Resolution and invalidation windows don't overlap for anyone except the admin. Once the timeout passes, the oracle is locked out. That makes the liveness fallback deterministic (flaw #3).

### 6.7 State machines

```
Round:   Open ──close_round──▶ Closed                 (no reopen instruction exists)
Market:  Unresolved ──resolve_market──▶ Yes | No      (round Closed, inside the window)
         Unresolved ──invalidate_market──▶ Invalid    (admin after close, or anyone after the timeout)
Order:   exists(remaining>0) ──fills──▶ exists(remaining=0)
         any ──cancel_order | sweep_order──▶ closed
```

### 6.8 Errors (named, frozen at V0)

`Unauthorized`, `InvalidMint`, `InvalidTokenAccount`, `InvalidMintConfig`, `RoleConflict`, `InvalidCoordinates`, `InvalidTriggerDistance`, `UnsupportedScenario`, `ScenarioMismatch`, `PreviousRoundOpen`, `InvalidDeadline`, `InvalidTimeout`, `RoundNotOpen`, `TradingEnded`, `RoundNotClosed`, `MarketResolved`, `MarketNotResolved`, `ResolutionWindowClosed`, `InvalidationNotAllowed`, `InvalidEvidenceHash`, `InvalidOutcome`, `InvalidSide`, `InvalidPrice`, `InvalidQuantity`, `InvalidExpiry`, `OrderExpired`, `OrderNotActive`, `OrderMismatch`, `OrderSeqMismatch`, `OrdersDoNotCross`, `PriceLimitExceeded`, `SelfTrade`, `NotSweepable`, `InsufficientPairs`, `LosingOutcome`, `InsufficientFunds`, `MathOverflow`.

### 6.9 Events

`RoundCreated`, `MarketCreated`, `SharesSplit`, `SharesMerged`, `OrderPlaced` (all order fields), `OrderFilled`, `OrderCancelled` (`swept: bool`, returned amounts), `RoundClosed`, `MarketResolved` (outcome, evidence hash), `SharesRedeemed`.

`OrderFilled { market, outcome, buy_order, sell_order, buyer, seller, quantity, price_bps, quote_amount, buyer_refund, maker_order }`. In a direct take, the taker's order field is `Pubkey::default()`. `maker_order` is the older or resting order. These events are the only source for trades, volume and charts. Use `emit!`. The demo's transactions are small enough that log truncation isn't a risk. A test asserts every event in a 4-level market order is parsed.

### 6.10 Security invariants (each has a named test, §13)

| # | Invariant |
|---|---|
| I1 | Collateral backing per §4.6 after every instruction |
| I2 | Only `split` mints. Market PDA is the sole mint authority. No freeze authority on any mint |
| I3 | Order escrow backs `remaining` per §5.2 after every instruction |
| I4 | Fill quantity ≤ remaining of each order. Execution price within both limits and equal to the older or resting price. Refund = `f × (buy.price − x) × 100` |
| I5 | Conservation: total mUSD across wallets, vaults and escrows is unchanged by every program instruction. YES and NO supply change only through `split` (+), `merge` (−) and `redeem` (−) |
| I6 | Lifecycle: trading only when Open, before the deadline and Unresolved; resolution only when Closed; one Open round; markets only in Open rounds with a matching scenario; one market per (round, property) |
| I7 | Authorities come only from Config. No instruction takes an authority as an argument |
| I8 | Each market resolves once. YES or NO only within the window. Invalid only by admin after close or by anyone after the timeout |
| I9 | Redemption burns only the signer's tokens, pays only the signer's mUSD account, only for winning or Invalid outcomes, at the exact amount |
| I10 | Cross-market isolation: every token account matches this market's mints, vault or the order's escrow, and `order.market == market` |
| I11 | Cancel and sweep return the full escrow and rent to the maker. A closed order can't be filled. ABA is defeated by `expected_seq` |
| I12 | Self-trade rejected |

---

## 7. Exchange service

Reuses `packages/server` (RPC fallback, keys, Explorer links, HTTP errors, `KeyedLock`, password check) and extends `services/indexer`.

### 7.1 Book

- Source of truth: `getProgramAccounts(Order)` with a `memcmp` filter on `market`, refreshed every 2 s and after every confirmed transaction the service submits.
- Hidden from the book: `remaining == 0`, expired orders, orders whose maker receiving ATA is missing, and markets that are resolved or whose round is closed.
- Separate YES and NO books. Bids descending and asks ascending, with ties broken by `seq`. Levels are aggregated by price, keeping the order list for building fills.
- Restart: rebuild entirely from accounts. No local state survives a restart, and none needs to.

### 7.2 Trades

- Parse `OrderFilled` and other events from `getSignaturesForAddress(program)`, paged back to the round's creation, reusing the stats indexer's paging. Deduplicate by `(signature, instruction index, event index)`.
- The chart, trade list and volume use **finalized** fills. The UI may show confirmed fills marked "confirming".

### 7.3 Chart (flaw #11)

- **Fills:** points at confirmed execution prices, with a quantity bar per point.
- **Quote history:** best bid, best ask and midpoint series rebuilt by replaying `OrderPlaced`, `OrderFilled` and `OrderCancelled` events through a pure reducer in `@metrex/exchange`. These are real commitments, rebuilt from chain data, and restart-safe.
- Labels: "Trades" and "Quoted midpoint". If neither exists, show "No quotes or trades yet". Never interpolate or invent points. The quote-history series can be cut (§14).

### 7.4 Keeper

- Every tick, for each active market and outcome: while best bid ≥ best ask and the makers differ, submit `match_orders` for the oldest eligible pair in price-time order, with `q = min(remainings)`.
- Act only on orders seen at `confirmed`. Allow one in-flight match per order. Refetch after any failure. Never assume success.
- After a round closes: sweep every remaining order of that round's markets in batches (permissionless, keeper pays fees, rent returns to makers).
- Uses a dedicated `keeper` keypair with no authority, kept in `~/.config/metrex/keeper.json`.

### 7.5 API (Next.js route handlers, reading the chain directly with a short in-memory cache)

`GET /api/rounds/latest`, `GET /api/rounds/:id`, `GET /api/markets?round=`, `GET /api/markets/:id`, `GET /api/markets/:id/book?outcome=yes|no`, `GET /api/markets/:id/trades`, `GET /api/markets/:id/chart`, `GET /api/health` (keeper heartbeat, bots heartbeat, RPC), plus the reused `POST /api/faucet`, `GET /api/evidence/:market`, `GET /api/stats`. Operator: `POST /api/operator/settle-round` (password header, §10.5).

Reads don't depend on the keeper process, so the book still shows when the keeper is down. A separate notice says matching is paused. When the service is unavailable, the UI shows "unavailable" and never cached or fabricated data presented as live.

---

## 8. Market-making bots

Reuse the `services/bots` worker shell: polling, idempotency, SOL and mUSD balance checks, rate limits and cleanup. Rewrite `strategy.ts` as pure functions in the style of `planRequotes`, with unit tests.

### 8.1 Behaviour

On a new Open market: split the configured inventory, then quote both books. Keep at most `max_orders` per market. Requote only when a target level differs from the resting order by ≥ 1 tick or ≥ 10% in size, using an atomic cancel-and-place transaction, with `cooldown_ms` between requotes. Track inventory from **actual token balances plus own escrows**, never from assumed fills. After close: sweep own orders and merge leftover pairs. After resolution: redeem winners.

### 8.2 Pricing (fixed illustrative beliefs, not forecasts)

| Bot | YES reference | Half-spread | Top size | Inventory tolerance |
|---|---:|---:|---:|---:|
| A | 400 bps | 30 | 200 | small |
| B | 450 bps | 50 | 150 | medium |
| C | 500 bps | 90 | 100 | large |

At zero inventory this gives YES bids 410 (C), 400 (B), 370 (A) and asks 430 (A), 500 (B), 590 (C). The highest bid is below the lowest ask, so the default ladder never crosses, and the post-only clamp is only a safety net. A test asserts this for the shipped parameters.

1. Skew: `ref' = ref + clamp(k × net_yes / tolerance, ±skew_max)`.
2. YES bid = `ref' − h`, YES ask = `ref' + h`.
3. **Complement NO quotes:** NO bid = 10,000 − YES ask, NO ask = 10,000 − YES bid. A bot's own quotes can then never offer split-and-sell or buy-and-merge arbitrage.
4. **Post-only clamp** against the live book (all makers, including other bots and users): bid ≤ best opposing ask − 1, ask ≥ best opposing bid + 1, applied to both books after step 3. Drop any level that clamping would invert. Bots never take liquidity, never cross each other and never fill a user's resting order through the keeper. This is what keeps the demo's resting remainder resting.

Property test: for random books and inventories, no bot quote crosses the book, and for every bot `yes_bid + no_bid ≤ 10,000` and `yes_ask + no_ask ≥ 10,000`.

### 8.3 Demo depth guarantee

On the featured market at zero inventory, the best YES bid is Bot C's 100 @ 410, so a 200-share sell limited at 410 fills 100 and rests 100. Bot B's next bid is 400, below the limit. The top two YES ask levels (A 200 @ 430, B 150 @ 500) hold at least 300 shares. The prepare script checks both (§12). The trade panel's live preview makes the demo correct even if the numbers drift.

### 8.4 Information isolation (flaw #14)

Bots never read settlement data. The worker exits at startup if `METREX_ORACLE_DATA_DIR` is set. A test fails if any file under `services/bots/src` imports `@metrex/geo`, `packages/server/src/oracle` or `data/`. Bot wallets are labelled in the UI as "MetrEx market maker A/B/C".

---

## 9. Oracle and settlement

Reuses `packages/geo` (evaluate with hole handling, canonical JSON, SHA-256) and `packages/server/src/oracle` (resolve, evidence store, finalized-and-hash-gated evidence route).

### 9.1 Historical replay

Settlement data is used only by the oracle, from `METREX_ORACLE_DATA_DIR`. The trading app, bots and keeper never load it. The UI discloses: **"Historical replay. The real outcome is public. Prices here are not forecasts."** The draft's "opaque scenario reference" is dropped: the scenario is public, and the dataset hash is committed on-chain.

### 9.2 Round-level closure

One `close_round` transaction stops trading on every member market (§5.9). There is only one Open round (§6.3), so publishing an outcome can't help trading in any other market on that fire.

### 9.3 Resolution (per market, idempotent)

1. Read the Round and Market on-chain. Require the round Closed, the market Unresolved and the time inside the resolution window. Otherwise skip (already resolved) or refuse.
2. Load the dataset by `scenario_id`. Require `sha256(file) == round.dataset_sha256`. Refuse on mismatch, and then the market goes to Invalid after the timeout.
3. Evaluate the on-chain Market coordinates (`@metrex/geo` `evaluate`).
4. Build evidence **v2** (canonical JSON): the v1 record plus `"round": "<base58>"`, with `"version": 2` and `program_id` set to the v2 program.
5. Submit `resolve_market`, wait for **finalized**, then write `evidence/<market>.json`.
6. `GET /api/evidence/:market` (including `?perimeter=1`) serves data only when the market is finalized as resolved and the file's hash equals the on-chain hash. This is the existing gate.

### 9.4 Replays

After the first settled round, the outcome is public on-chain and through MetrEx's own evidence API. Later rounds are labelled "replay". MetrEx claims no secrecy. The secret longitude-shift "blind replay" in [the v1.2 design review](v1.2-design-review.md) §2 remains an owner decision and is out of scope.

### 9.5 Failure

Closing never depends on the oracle. If resolution fails partway, trading stays closed, resolved markets stay final and unresolved markets stay pending. The oracle retries idempotently until the window ends. After that, anyone can invalidate. No evidence is published before that market's finalized resolution.

---

## 10. Frontend

Reuse the v1 shell: the white and black Geist layout from the UI overhaul, wallet adapter, `useWalletSigner`, `usePoll`, `batch.ts` transaction building and size checks, `format.ts`, and the fixture guard in `env.ts` (production builds fail with `NEXT_PUBLIC_USE_FIXTURES=1`). The v1 pages are retired from navigation at Gate V5 (§14).

### 10.1 Required text (plain text, no pills)

- The trigger sentence (§1.1) on every market page.
- "Historical replay. The real outcome is public. Prices here are not forecasts."
- Next to the trade button: "If the market is declared invalid, every share pays 0.50 mUSD. Buying above 0.50 can lose money on invalid."
- House liquidity: "Liquidity is provided by MetrEx-operated market makers", and bot addresses are labelled in trades.
- Explorer links use `?cluster=devnet`. Evidence and perimeter appear only after finalized settlement with a matching hash.

### 10.2 Homepage `/`

Opens the featured market of `Config.latest_round`, where `NEXT_PUBLIC_FEATURED_PROPERTY` defaults to 1. Shows the question, YES price, volume (sum of finalized `quote_amount`), round state, the round's other markets and the wallet's mUSD. Earlier rounds appear only on `/rounds`, with their outcomes labelled.

### 10.3 Market page `/market/[id]`

- **Header:** question, state (Open, Trading closed, Resolved YES/NO/Invalid), volume, and a map with the 500 m radius. The perimeter appears only after settlement.
- **Prices:** YES and NO headlines. Each is the book midpoint when both sides exist and the spread is ≤ 1,000 bps, otherwise the last finalized fill, otherwise "—". The label names the source ("mid", "last").
- **Chart:** §7.3.
- **Book:** YES/NO toggle, aggregated levels, best bid and ask, spread and depth.
- **Trade panel:** Buy or Sell, YES or NO, Market or Limit, quantity and limit price. For a market order: a slippage setting with a 200 bps default and the worst price. Before signing, it previews the fill: X fills now at an average of Y, Z rests, and the escrow amount. The app simulates the transaction and shows a program error in plain words without opening Phantom (for example, "Trading has closed for this round").
- **Wallet:** YES and NO holdings, available and reserved mUSD and shares (computed from the wallet's orders), open orders with cancel buttons, recent fills, and a redeem button. The redeem transaction combines the wallet's sweeps with `redeem`.
- **Settlement:** outcome, perimeter, evidence hash recomputed in the browser against the chain, and the redemption amount.

### 10.4 Displayed amounts (no P&L)

| Action | Cost / proceeds | Max payout | Max loss |
|---|---|---|---|
| Buy `q` at average `p` | `q·p` | `q` (or `0.5q` on Invalid) | `q·p` |
| Sell `q` held shares at `p` | receive `q·p` now | — | gives up `q` if that outcome wins; shown as "These shares would pay q if YES wins" |
| Limit BUY resting | escrows `q·p` | as Buy | as Buy |

### 10.5 Portfolio `/portfolio`

Available mUSD; YES and NO holdings per market; reserved balances; open orders; claimable redemptions (holdings × payout per resolved market); completed redemptions and recent fills from events. P&L is not shown.

### 10.6 Operator `/operator` (password, never linked from the trading UI)

Reuses the `/demo` route's password and lock pattern. It covers round inspection, bot and keeper health, liquidity checks and the **Close and settle** workflow. The workflow is resumable and reads its state from the chain on every step:

1. `close_round`, skipped if already Closed. Wait for finalized.
2. Show that trading is rejected: simulate a `take_order` on the featured market and display `RoundNotOpen`.
3. For each market: oracle resolution (§9.3), skipped if resolved.
4. Show the perimeter and the evidence hash match.
5. Sweep the remaining orders (keeper).
6. Check completeness: `resolved_count == market_count`, and no orders remain.

Every on-chain step is its own verifiable transaction with an Explorer link.

---

## 11. Four-minute demo

**Round:** a fresh round with Home #1042 (featured, settles **YES**) and Home #2210 (settles NO, providing the independent NO validation in the same round). Three bots run. One funded, connected Phantom wallet. Nothing is closed in advance.

| Time | Beat | What is real |
|---|---|---|
| 0:00–0:35 | Open the featured market: question, trigger sentence, YES and NO prices, quoted midpoint chart, book | Every level is an on-chain order with an escrow. Click one in Explorer |
| 0:35–1:15 | **Buy 300 YES at market.** One Phantom signature | `take_order` × 2 levels (A 200 @ 430, B 100 @ 500); fills, average price and new balance from events; the book shrinks |
| 1:15–2:05 | **Sell 200 YES, limit at the best bid.** The preview says "100 fills now, 100 rests". One signature | `place_order` and `match_orders` against Bot C's 100 @ 410. Proceeds `100 × 410 × 100` = 4.1 mUSD at Bot C's price. The order shows 200/100 resting. The portfolio shows the reserved shares |
| 2:05–2:55 | Operator: **Close and settle.** Rejected-trade proof, oracle, perimeter reveal, YES | Separate `close_round` and `resolve_market` transactions, finalized. Hash verified in the browser |
| 2:55–3:35 | **Redeem.** One signature sweeps the presenter's resting 100 and redeems 200 YES | +200 mUSD, YES burned, payout transaction in Explorer |
| 3:35–4:00 | Close: "Catastrophe exposure as fully collateralized, liquid positions anyone can trade on Solana, settled by an objective oracle." | |

Numbers at zero bot inventory: buying 300 YES costs 8.6 + 5.0 = 13.6 mUSD. Selling 100 returns 4.1 mUSD. Redeeming 200 YES pays 200 mUSD. Exact prices come from the live book, and the trade panel preview shows them before each signature.

---

## 12. Demo repeatability — `scripts/prepare-demo-v2.ts` (idempotent)

1. Verify the Devnet genesis hash, the v2 program ID, Config, and that the collateral mint is the existing mUSD mint.
2. If the latest round is Open: if it is fresh (created by this script, only bot fills) and has more than 2 h to its deadline, reuse it. Otherwise settle it first: close, resolve each market, sweep. Never reopen a round or reuse a resolved market.
3. Create a new round with the committed dataset hash from `data/scenarios.json` and `trading_ends_at = now + 24 h`. Create markets for properties 1 and 2.
4. Top up bots, keeper and presenter (reuse `fund-bots.ts` and `fund-wallet.ts`). Wait for the bots to split and quote.
5. Verify the depth guarantee (§8.3), keeper and bot heartbeats, and that the oracle loads the dataset and the hash matches. Do this without evaluating or printing any outcome.
6. Print the featured market URL, the operator URL and the checklist.

---

## 13. Tests

### 13.1 Program (Anchor, local validator)

A helper `assertMarketInvariants(market)` checks I1, I3 and I5 after **every** state-changing call in every test. Financial invariants are always exercised through program instructions, never through direct balance edits.

- **Tokens:** split, merge and repeated split/merge cycles. Merge after close succeeds and after resolution fails. Split after close fails. Redeem YES, NO and Invalid, partial and full. Losing redeem is rejected. Double redeem fails for lack of balance. A redemption to another wallet's account is rejected. Unsolicited vault deposit and holder self-burn keep I1 at `≥`.
- **Orders:** BUY and SELL placement escrow. Insufficient balance. Price 1 and 9,999. Quantity 1 and `MAX_ORDER_QTY`. Overflow attempts. Expired placement.
- **Fills:** take at the maker price; taker limit violated; `expected_seq` ABA (cancel and re-place the same nonce at a worse price → `OrderSeqMismatch`); two takers competing for one order, where the second gets the remainder or fails; self-trade; wrong market's mint; wrong escrow; match at the older price both ways with an exact refund; partial fills down to zero; fill after cancel; cancel after a partial fill; the same escrow in two matches in one transaction.
- **Lifecycle:** fills fail after `close_round` and after `trading_ends_at`. Anyone can close after the deadline but not before. A second Open round is rejected. Market in a Closed round rejected. Scenario mismatch rejected. Duplicate (round, property) rejected. Resolve before close is rejected. Resolve twice is rejected. Resolve after the timeout is rejected. Non-admin invalidation before the timeout is rejected. Permissionless invalidation after the timeout succeeds. Unauthorized signers are rejected for every role.
- **Recovery:** sweep after close returns SELL shares and BUY mUSD with rent to the maker. Sweep before close is rejected unless expired or filled. Sweep after the maker closed its ATA recreates it. Redeem after sweep succeeds. Resolution while orders are still escrowed succeeds.
- **Size:** a serialized 4-level market order and a 3-level limit order fit in 1,232 bytes and under the compute limit, with all events parsed.
- **End-to-end conservation:** full YES, NO and Invalid lifecycles with three makers and two takers. Total mUSD is conserved, and every winner receives exactly its entitlement.

### 13.2 TypeScript

- `@metrex/exchange`: quote math, book projection, price-time ordering, cross detection, the market-order planner (levels, slippage, level limits) and the chart reducer.
- Bots: no-cross and no-arbitrage property tests, complement quotes, skew bounds, requote thresholds, and the isolation import test.
- Indexer: event deduplication, restart rebuild giving an identical book, and hiding orders with a missing ATA.
- Oracle: round gate on-chain, dataset hash mismatch refusal, evidence v2 canonical bytes, idempotent retry.

### 13.3 Devnet (Gate V4)

Real round, markets, splits, bot depth, a market buy, a limit order with a partial fill, a cancel, round closure with a rejected trade, YES and NO resolution with matching hashes, and redemptions with balances checked to the base unit. Record everything in `docs/v2-devnet-verification.md`.

---

## 14. What v2 reuses from v1

| Keep (adapt) | From | Use in v2 |
|---|---|---|
| Toolchain pin, upgrade-authority init, keypair layout | `Anchor.toml`, `initialize_config.rs`, `~/.config/metrex` | Same pins. New program keypair `metrex-exchange-program.json` and `keeper.json` |
| mUSD mint, mint authority, faucet | Devnet mint, `routes/faucet.ts`, `fund-wallet.ts` | Unchanged. Bots already hold mUSD |
| Property registry and data | `register_property.rs`, `data/DATASET.md`, `scenarios.json` | Same three points, re-registered in the v2 program |
| Geo and evidence | `packages/geo` | Unchanged, plus an additive evidence v2 builder |
| Oracle, evidence gate, password, locks, RPC fallback | `packages/server` | Round gate moves on-chain. Dataset hash checked against `Round` |
| Stats indexer | `packages/server/src/stats`, `services/indexer` | Extended with the book, trades and keeper |
| Bot worker shell and displacement-requote experience | `services/bots` | New `strategy.ts` (§8) |
| App shell, wallet, batching, polling, fixture guard, settlement view | `app/` | New pages. `/demo` becomes `/operator` |
| v1.1 program | `programs/metrex` | **Frozen. Never upgraded.** It stays the fallback demo at tag `v1.1-demo` |

New: `programs/metrex-exchange/`, `tests/exchange.ts`, `packages/exchange/` (`@metrex/exchange`: constants, PDAs, account types, quote math, book, planner, chart reducer; frozen at V0 like `@metrex/shared`).

**Cut order if time runs short:** quote-history chart line → keeper race matching (keep sweeping) → order expiry → `/rounds` page → permissionless invalidation (keep the admin path and timeout lockout). **Never cut:** I1–I12 tests, atomic round close, YES and NO on Devnet, the required text in §10.1, take-then-rest limit orders.

---

## 15. Owner decisions required before Gate V0

| # | Decision | Recommendation |
|---|---|---|
| D1 | New program ID for v2. Keep v1.1 frozen as the fallback | Yes |
| D2 | Devnet SOL for the v2 deploy: about 4–5 SOL for program rent, plus bots, keeper and presenter | Human funds the deployer through the Solana Foundation faucet, as for Gate 2 |
| D3 | Resolution timeout and permissionless invalidation; admin early invalidation kept and disclosed | Yes. 86,400 s on Devnet |
| D4 | Featured market Home #1042 (YES), with Home #2210 (NO) in the same round | Yes |
| D5 | Markets listed by the controller only (homeowners no longer create markets) | Yes |
| D6 | Seeded warm-up trades from a labelled team wallet (`judge-1`) so the chart has fills at 0:00 | No. The quote-midpoint history (§7.3) already shows real data, and staged trades invite questions |
| D7 | Blind replay (secret longitude shift) | No. Out of scope, as in the v1.2 review |

---

## 16. Known limits (disclose, don't fix)

- **Trusted roles:** the oracle decides the outcome against a committed dataset, the controller decides when to close, and the admin can invalidate early. Mitigation: close and resolve back to back, and the timeout lockout.
- **Matching fairness:** price-time priority is service policy. A different client can choose a different eligible counterparty. Limit prices and escrow are always enforced.
- **Public outcome:** this is a replay, so the house bots lose to anyone who checks the public perimeter. mUSD has no value.
- **Peer-to-peer transfers** of shares continue after close at the SPL level.
- **Separate YES and NO books:** without complementary matching, NO liquidity depends on makers quoting NO. The bots always do.

---

## 17. Release acceptance

- [ ] The default interface is the v2 exchange. v1 is reachable only at tag `v1.1-demo`
- [ ] Fungible 0-decimal YES and NO mints per market, minted only by `split`
- [ ] I1–I12 pass on the local validator, with `assertMarketInvariants` after every operation
- [ ] Split and merge from the UI; BUY and SELL limit orders with real partial fills; cancel and reclaim; market buy and sell within the level limits
- [ ] Three bots maintain post-only, non-crossing quotes on both books of the featured market
- [ ] The book, chart, trades and volume come only from on-chain orders and finalized events
- [ ] One `close_round` stops trading on every member market, shown by a rejected simulation
- [ ] The oracle settles without revealing anything before the finalized resolution. Hashes match in the browser
- [ ] Winning shares redeem for exactly 1 mUSD; Invalid pays 0.5 mUSD per share. YES, NO and Invalid conservation tests pass
- [ ] The four-minute demo runs end to end with one Phantom wallet, and `prepare-demo-v2.ts` prepares it again from a fresh round
- [ ] Rust, Anchor, TypeScript tests and the production build all pass
