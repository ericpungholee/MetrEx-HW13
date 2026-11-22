# MetrEx V7 — market simulation addendum

Addendum to [spec-v2](spec-v2.md) and [spec-multiperil](spec-multiperil.md), approved by the owner on 2026-11-21. It adds a population of simulated traders that trade the four catalog markets through the unchanged `metrex_exchange` program, replaces the fixed maker ladder with adaptive quoting, and defines the demo lifecycle and operator controls. Where this document says so, it wins over spec-v2 §8.2–§8.3 and spec-multiperil §6. **No program, account layout, PDA, instruction, error or event changes.** No frozen interface changes.

## 1. Principles

1. We simulate **participants**, never the exchange. Every price, fill, level, chart point and volume figure still comes from on-chain accounts or finalized events (CLAUDE.md, Frontend). The simulator never writes chart points, never backdates, never fakes a fill.
2. Each simulated trader is a distinct Solana wallet with finite test mUSD. It signs its own trades. Its balances, escrow and holdings are enforced on-chain.
3. No self-trade (rejected on-chain), no wash pairs: a trader never takes its own order, and the planner never routes two sim wallets of the same decision against each other.
4. Simulated traders are labelled in the UI ("Simulated trader 042"). The demo is presented as simulated participants trading on Devnet.
5. **Information isolation (spec-v2 §8.4) extends to the simulator.** It refuses to start when `METREX_ORACLE_DATA_DIR` is set, and a test forbids importing `@metrex/geo`, the oracle or `data/`. Its risk bulletins are random, drawn from a seeded generator, and carry no settlement information. Bulletins are unbiased in direction.
6. Market makers remain post-only, quote NO as the exact complement of YES and never cross the book (spec-v2 §8.2 steps 2–4 unchanged). Only step 1 (the reference) changes, per §3.

## 2. Population

`services/sim` manages up to 100 persistent traders in one process (no LLMs, no ML). The population is generated deterministically from `SIM_SEED`. Public fields (index, archetype, wallet, starting capital) are written to `$METREX_KEY_DIR/sim/population.json`. Keypairs live in `$METREX_KEY_DIR/sim/trader-NNN.json`, never in the repo.

| Archetype | Count | Capital (mUSD) | Behaviour |
|---|---:|---|---|
| Retail | 35 | 500–5,000 | Small noisy YES/NO market orders, lottery tilt toward YES, take profit or cut losses |
| Homeowner | 25 | 5,000–30,000 | Buys YES toward a coverage target on one hazard, mostly limit bids, holds |
| Risk investor | 20 | 20,000–100,000 | Believes risk is overpriced, accumulates NO, posts NO bids |
| Quant | 10 | 25,000–100,000 | Complement arbitrage (buy both + merge, split + sell both), tight fair-value trades, short-lived limit quotes |
| Momentum | 7 | 5,000–25,000 | Follows recent YES mid moves in log-odds, exits after a holding period |
| Large | 3 | 250,000–500,000 | Rare large sweeps of up to `MAX_TAKE_LEVELS` levels |

Each trader has a persistent personality: activity rate, preferred hazards, per-hazard belief bias (log-odds), news sensitivity, stubbornness toward the public starting quote, edge threshold, order-style mix, size range and maximum exposure per market.

Beliefs: `logit(p) = (1−λ)·logit(market mid) + λ·logit(starting quote) + bias + sensitivity·signal(hazard, t) + noise`. A trader buys YES when its belief exceeds the YES ask by its edge in log-odds, buys NO when its belief is below the NO-implied YES price by its edge, and sells holdings when the opposite holds. Sizes are bounded by free mUSD, held shares and maximum exposure. Exposure is valued at mid, so each trader also has a **holding cap** in shares: shares of one outcome held plus resting bids for it never exceed a per-archetype multiple of its capital (retail 3×, homeowner 10× bounded by its coverage target, risk investor 2×, quant 0.25×, momentum 2×, large 0.2×). At sub-cent YES prices an mUSD cap alone would let a few traders demand millions of YES shares, and every YES a maker sells needs 1 mUSD of split collateral. Homeowner coverage targets are 5,000–40,000 shares, and risk investors' per-hazard bias averages −0.45 log-odds (they lean NO), so maker NO inventory has buyers.

**Finite capital.** Provisioning mints each trader's starting capital once and records it. Re-running provisioning never tops a trader back up.

## 3. Adaptive maker quoting (replaces spec-v2 §8.2 step 1 and spec-multiperil §6 "skew off")

The catalog ladder is the **starting** quote. Each market keeps one adaptive mid `m`, initialised from maker A's resting YES bid and ask (restart recovery), else from the catalog. Each worker tick:

1. Observed fills are derived from the `remaining_qty` decrease of every order in the market between two consecutive loads (an on-chain account diff; the executed price is the resting order's price, spec-v2 §5).
2. `m` moves toward the volume-weighted YES-equivalent fill price, and by a bounded impact of signed taker flow (YES buys and NO sells raise it).
3. `m` reverts slowly toward the makers' own independent estimate (the catalog reference), half-life `BOTS_ANCHOR_HALF_LIFE_MIN` (default 45 min).
4. Each step is capped (default 12%), and `m` stays within ×10 of the catalog reference and inside 1–9,999.
5. Recent volatility widens the half-spread (×1 to ×3).
6. Inventory skew is enabled on catalog markets, with `skew_max` equal to the scaled half-spread.
7. Bot i quotes `ref_i = catalogRef_i · m / catalogRef_A` with half-spread `catalogHalf_i · m / catalogRef_A · volMult`, at least 1 bps. A dead band (2.5% or 0.75 bps) prevents requote churn.

Each maker is seeded with `MAKER_CAPITAL` (1,500,000 mUSD). One quarter of that budget (375,000 mUSD) limits new collateral commitments per catalog market. The worker counts booked bid escrow and values the larger of its YES or NO inventory at full payout for this limit. Holdings include shares escrowed in asks. A split requires a side below one top size, room under the inventory multiple, and unreserved wallet cash. Unfilled bids can fund their own atomic replacement. Each tick reserves free collateral shared across markets and carries those reservations while transactions are in flight.

A maker posts no quote smaller than one tenth of its top size, and cancels one that shrinks below it (`minQuoteFraction`). A dust order at the best price would hide the deeper book behind the fixed 5% market-order tolerance (spec-multiperil §7.4): on 2026-11-22 a cash-starved maker A rested 347 YES at 1.19¢ with maker C next at 1.74¢, so a 10-share market buy could fill only the dust. A maker that cannot fund a real size leaves the level to the next maker.

The worker merges free surplus YES and NO pairs to release mUSD. It retains one top size plus half a split batch of each outcome, including resting asks, and merges only when at least half a split batch is available above that buffer. Existing quotes and inventory can trade and unwind if a market passes its budget. Sustained one-sided fills can still exhaust replenishment on that market. The maker heartbeat publishes free mUSD, commitments and depth by market, and the worker logs when a book is thin. Startup checks for maker quotes on all four sides and keeps healthy services running if a book stays thin.

`BOTS_ADAPTIVE=0` restores the fixed ladder. The prepare-script depth assertions of spec-v2 §8.3 apply to the loopback rehearsal only.

## 4. Sponsored fees and accounts

- A sponsor wallet (`sim-sponsor`) is the **transaction fee payer** for every simulator transaction. The trader co-signs as owner.
- The frozen contexts make the trader pay rent for its own `place_order` accounts (`payer = maker`) and any `init_if_needed` ATA. So the simulator creates each trader's ATAs idempotently in the same transaction **with the sponsor as payer**, before the program instruction runs. Market orders therefore need no trader SOL.
- Traders that post limit orders (homeowners, risk investors, quants) get a small SOL float (default 0.015 SOL) for order rent, which `cancel_order` returns. Resting limit orders per trader are capped at 2, and a limit order never exceeds `MAX_ORDER_QTY`.
- Once a market resolves and a trader's outcome account is empty, the simulator closes it with the sponsor as rent destination, so each market generation returns the account rent it cost.
- Below a sponsor floor (0.1 SOL) the simulator starts no new trades and keeps unwinding and redeeming (heartbeat state `low_funds`).

## 5. Execution

- One process, one batched `ExchangeStateLoader` read per tick covering every book and every trader's SOL, mUSD, YES and NO balances.
- Each trader decides at a Poisson rate. Decisions are planned against the snapshot with the pure `planMarketOrder` and executed with `take_order` (taker's limit price and `expected_seq`), `place_order`, `cancel_order`, `split` and `merge`.
- At most one transaction in flight per trader, a global concurrency cap (`SIM_MAX_IN_FLIGHT`, default 6) and additive-increase/multiplicative-decrease backpressure on RPC errors.
- A trader is re-planned only from a load that started after its last transaction settled (no stale double-sends). `sendTx` never re-sends a signature that may still land.
- Ramp with `SIM_TRADERS` (20 → 50 → 100) and `SIM_RATE` (activity multiplier).
- After close: cancel own orders and merge pairs. After resolution: redeem winners (same lifecycle as makers), so a fast-forwarded market pays out the population without operator action.
- Positions always come from chain balances. The simulator keeps no P&L of its own: every P&L figure is the ledger of §8.

## 6. Demo scope and lifecycle

Four catalog markets (one per hazard). No market-creation flow, no extra properties, no extra hazards. A Phantom user trades the same books as everyone else, with no special treatment.

- **Trading window.** A new demo round trades for `DEMO_TRADING_HOURS` = 168 hours from its creation (`trading_ends_at` on-chain). This Devnet window is unrelated to the historical coverage month the market replays.
- **Restarts never move deadlines.** The launcher runs `prepare-multiperil --keep-settled`: it reuses the newest round of each scenario whatever its state, never rotates, and creates a round only when a scenario has none.
- **Natural deadline.** Trading stops on-chain at `trading_ends_at`. The launcher's supervisor then runs the normal oracle settlement (`settleRound`) for that round only and opens nothing new.
- **Settled markets stay featured** with their result until the operator resets them (§10).
- The market page shows the remaining time to the on-chain deadline.

## 7. Fast-forward to settlement (operator)

**Fast-forward to settlement** runs for one catalog round as one `POST /api/operator/settle-round { action: "fast_forward", round }`. The market page Settle market button sends it (§7.1):

1. Hold local workers off the round. Build the evidence from the dataset whose hash the round committed (a mismatch or missing coverage refuses, and nothing is sent).
2. Send `close_round` (controller) and `resolve_market` (oracle) **in one transaction**, confirmed. This stops trading on that market only, because each catalog market has its own round, and makes winning shares redeemable within seconds. The evidence never depends on `closed_at`, so it is the same record the step-by-step path publishes.
3. After finalization, prove closure: a signed take with preflight skipped must fail `RoundNotOpen` with balances unchanged. If no funded proof taker exists the proof is skipped and reported, because the program rejects trades on a Closed round regardless.
4. Release the hold. `settleRound` verifies the finalized settlement, publishes the evidence and sweeps every resting order (escrow and rent back to makers).
5. Makers and simulated traders redeem on their next tick. Phantom users redeem manually.

The button advances the lifecycle. **It never chooses the outcome.** The step-by-step actions remain available through the same endpoint.

### 7.1 Settle and Reset on the market page

Owner decision (2026-11-21): the app has no authentication other than the Phantom wallet. Every market page shows **Settle market** and **Reset market** side by side under the trade ticket, to everyone, before and after settlement. There is no operator sign-in or settings panel on the market page. Each button asks for confirmation. Neither has logic of its own:

- **Settle market** sends `fast_forward` with this market to `POST /api/operator/settle-round`, which runs the §7 fast-forward. `close_round` stops every member market of the round, so Settle settles the whole round. Owner decision (2026-11-22): this is allowed when the round has sibling markets, for example listed homes (spec-multiperil §7.7). The confirmation states how many markets settle together. The server refuses only a market that is not a member of the named round. The per-round lock rejects a duplicate while one runs.
- **Reset market** sends `reset_market` for this market's round to `POST /api/operator/demo` (§9), before or after settlement. The page follows the journaled operation. When it completes, the page resumes the simulated traders if they were paused and navigates to the replacement market. The replaced market disappears from the portfolio, including any shares or unredeemed winnings in it (owner decision, 2026-11-21). Those tokens stay on-chain and the program still honours them, but the app no longer shows or lists them (there is no past-rounds page). Human wallets and the other markets are untouched.

Status, outcome, risk map, evidence and the claimable payout update from the normal polls. Winners redeem from the Position panel through Phantom. The protocol is unchanged.

## 8. Trade and settlement ledger

`GET /api/markets/:id/ledger` and `/market/:id/ledger` rebuild everything from the market's **finalized** `OrderFilled`, `SharesSplit`, `SharesMerged` and `SharesRedeemed` events plus the vault balance (pure `buildLedger` in `@metrex/exchange`):

- **Trade ledger:** every fill with buyer, seller, book, price, shares, mUSD, time and transaction signature.
- **Settlement ledger:** per wallet, shares still held, mUSD paid (buys and splits), received (sales and merges), paid out, still claimable, net P&L (after resolution), and redemption signatures. Makers and simulated traders are labelled. The connected wallet is "You".
- **Collateral reconciliation:** booked collateral = splits − merges − payouts. The vault must hold at least that and at least every outstanding claim. Payouts never exceed deposits, and stranded surplus is reported. With no fees, net P&L sums to zero across all wallets after resolution.

## 9. Operator demo controls

There is no `/operator` page (removed 2026-11-21). These controls remain as `GET/POST /api/operator/demo`, with Reset Market on every market page (§7.1) and Reset Demo in `scripts/reset-demo.ts`:

- **Start / Pause simulation.** Pausing stops new simulated trades only. Makers keep quoting, closed markets still unwind, and on-chain deadlines never change.
- **Reset Market** (one catalog market). Settle its round through the oracle if needed (as §7), keeping its history and every claim, then open a fresh round and market for the same property and scenario with the full 168-hour window. Makers quote it on their next tick. Simulated traders keep their wallets and remaining capital (nothing is minted) and start fresh strategy state for the new market. The other markets are untouched.
- **Reset Demo.** Hold the simulator and makers (they acknowledge and drain in-flight transactions), settle and archive every featured round through the oracle, sweep, redeem the simulated traders' and makers' winning shares, then restore each simulated trader to its seeded capital and each maker to `MAKER_CAPITAL` with explicit Devnet `mint_to` or `burn` transactions (exact amounts, journaled), restore SOL floats only where a wallet fell below two thirds of its float, and open four fresh 168-hour rounds. Workers resume and the simulator resets its strategy state.
- Human wallets (Phantom, judges, the homeowner demo wallet) are never read for restoration, signed for or changed. After a reset their positions in the replaced rounds no longer appear in the portfolio; the tokens and the program's redemption rules are unchanged on-chain.
- One operation at a time, journaled in `operation.json` (phase, log, signatures). `DemoTransactions` records signed bytes before broadcasting, so a resume after a crash never double-mints. A stopped Reset Market resumes when Reset market is pressed again, and `resume_operation` resumes any stopped operation. Conflicting operations are refused while one runs; fast-forward refuses during a reset. `scripts/reset-demo.ts [--resume]` runs the same operation from a terminal.
- Health: makers, keeper and simulator heartbeats, simulator fills per minute and failures, RPC, and every operator wallet's SOL and mUSD with low-balance flags.

## 10. Out of scope

Unlimited replenishment, any trader reading settlement data, LLM-driven agents, fake or backdated events, protocol changes, market creation in the demo, more markets or hazards.
