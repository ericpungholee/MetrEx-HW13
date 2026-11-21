# MetrEx Exchange v2 — Build Plan

**Builds:** [spec-v2.md](spec-v2.md). Every agent reads it first. § numbers in this file refer to it.
**Team:** one human integrator and parallel coding agents (the same operating model as [build-plan.md](build-plan.md) §1).
**Gates:** V0–V6. The v1 gates (0–6) all passed, and the v1.1 program stays frozen.

Work is ordered by gates. Move on as soon as a gate passes.

---

## 1. Rules carried over from v1

1. **Freeze interfaces first (V0).** The new program's accounts, seeds, instruction arguments, errors, events and `@metrex/exchange` are compiled and committed before any workstream starts. After that, only the human changes them.
2. **One directory per workstream**, one branch per agent. Merge only at gates with tests passing.
3. **The spec wins.** If it looks wrong, stop and record it in `docs/STATUS.md`.
4. **`programs/metrex` (v1.1) is never modified or upgraded.** v2 is a new program at a new ID.
5. **The v1 app stays the default until V5 passes.** Tag the current main as `v1.1-demo` before C replaces any page.
6. No separate audit. Hackathon scope with valueless Devnet mUSD: the per-test invariants, the §13.1 attack tests and the V2 exit checklist (§4 R) replace a fresh-agent review.

## 2. New and changed paths

```text
programs/metrex-exchange/src/   A   lib.rs, state.rs, errors.rs, events.rs, constants.rs, instructions/*.rs
tests/exchange.ts               A   + tests/helpers/invariants.ts (assertMarketInvariants)
packages/exchange/              G0  @metrex/exchange: constants, PDAs, account types, quote math   (frozen at V0)
                                E   book projection, planner, chart reducer                        (pure, added after V0)
packages/geo/                   D   additive evidence v2 builder
packages/server/                D/E oracle round gate on-chain, dataset hash check; book/trades/chart readers
services/indexer/               E   book cache, trade index, keeper, heartbeat
services/bots/                  D   strategy.ts rewrite (§8); worker shell reused
app/                            C   new /, /market/[id], /portfolio, /operator, /rounds; v1 pages retired at V5
scripts/                        D   setup-devnet-v2.ts, prepare-demo-v2.ts; fund-* reused
```

## 3. Gate V0 — architecture freeze

**Human:** approve the spec-v2 §15 decisions D1–D7. Generate the `metrex-exchange-program` and `keeper` keypairs in `~/.config/metrex/`, and back up the program keypair. Start requesting Devnet SOL for the deploy (about 4–5 SOL).

**Agent G0 brief:**

> Read `docs/spec-v2.md` §3–§6. Create `programs/metrex-exchange` with compiling stubs: every account with all fields and `InitSpace`, and every instruction in §6.6 with its full `Accounts` context (seeds, `has_one`, mint and authority constraints, read-only Market and Round on `take_order`/`match_orders`) and an empty body. Add the error enum §6.8, events §6.9 and constants §3. Use the same Anchor and Agave pins as `Anchor.toml`. Add the program to `Anchor.toml` and `Cargo.toml` without touching `programs/metrex`. Create `packages/exchange` with constants, PDA helpers taking the program ID as a parameter, account types, and `quote(q, bps)`. Add an IDL-sync test modelled on `packages/shared/src/idl-sync.test.ts`. Run `anchor build` and commit the IDL. No business logic.

**Exit:** `anchor build` passes with no warnings, the existing v1 tests still pass, the IDL is committed and the human has checked the seeds against §6. **Freeze.**

## 4. Workstreams

### A — Program and tests (V1, then V2)

> Implement `programs/metrex-exchange` per §4–§6. Write `tests/exchange.ts` covering every §13.1 item. `assertMarketInvariants` runs after every state-changing call. Configure the local `resolution_timeout_s` as 10. First **V1**: config, property, round, market, split, merge, resolve, invalidate, redeem. Then **V2**: orders, take, match, cancel, sweep, cutoff, the transaction-size test. Do not change frozen interfaces. If one is wrong, stop and report.

**V1 acceptance:** I1, I2 and I5–I9 have named passing tests. YES, NO and Invalid conservation pass.
**V2 acceptance:** I3, I4, I10–I12 and every adversarial case in §13.1 pass. The 4-level take and 3-level limit transactions fit.

### E — Exchange engine (starts at V0 with pure code, integrates at V2)

> In `packages/exchange`, implement pure, unit-tested functions: book projection (§7.1), price-time ordering, cross detection, the market-order and limit-order planners (§5.5, §5.7: level limits, slippage, expected_seq), and the chart reducer (§7.3). In `services/indexer`, add the book cache, trade index with deduplication, keeper (§7.4) and heartbeat. Add the §7.5 route handlers through `packages/server`. Reuse the RPC fallback, the stats paging and `KeyedLock`.

**Acceptance:** a restart rebuilds an identical book. A crossed pair is matched once. Event deduplication passes. Reads work with the keeper stopped.

### D — Bots, oracle, scripts (strategy at V0, integration at V3)

> Rewrite `services/bots/src/strategy.ts` per §8 as pure functions with property tests (no-cross, complement NO, skew bounds). Add the isolation test and the startup guard (§8.4). Adapt `packages/server/src/oracle` to §9.3: on-chain Round gate, dataset hash against `round.dataset_sha256`, evidence v2. Write `scripts/setup-devnet-v2.ts` (Config with the existing mUSD mint, the three properties) and `scripts/prepare-demo-v2.ts` (§12).

**Acceptance:** on a local validator, three bots quote both books of two markets within 10 s and never cross. The §8.3 depth guarantee holds. Close, resolve and evidence complete with matching hashes. A second prepare run settles the stale round and opens a fresh one.

### C — Frontend (fixtures at V0, live at V4)

> Build §10 on the existing app shell. All chain access goes through `app/lib/exchange-client.ts`. Fixtures stay behind `NEXT_PUBLIC_USE_FIXTURES=1`, and production builds fail with it on. Required text from §10.1 appears on every market page. The trade panel previews fills and simulates before opening the wallet. `/operator` reuses the `/demo` password and lock pattern.

**Acceptance:** every page renders against fixtures. The market buy and limit order build one transaction each. A simulated `RoundNotOpen` is shown in plain words.

### R — V2 exit checklist (the implementer, about 30 minutes, no separate agent)

Hackathon scope: mUSD is valueless and Devnet-only, so the goal is that a judge with Phantom can't break the live demo, not a full audit. Before V2 passes, the implementer checks the order code for these and adds a test for any gap:

- [ ] Every token account is bound to this market's mints, vault, or this order's escrow (I10)
- [ ] Payouts and refunds use booked amounts (`remaining_qty`, `pairs_outstanding`), never the raw balance
- [ ] Every trading instruction checks the round is Open, before `trading_ends_at`, and the market is Unresolved
- [ ] `take_order` checks `expected_seq` and the taker's limit price. Fills never exceed `remaining_qty`
- [ ] Cancel and sweep always return the full escrow and rent to the maker
- [ ] Fills and matches take Market and Round read-only

Record the result in `docs/STATUS.md`. There is no re-audit before V6. The Phantom rehearsal is the final check.

## 5. Gates

| Gate | Needs | Running | Passes when |
|---|---|---|---|
| **V0 — Freeze** | D1–D7 approved, keypairs | G0 | IDL and `@metrex/exchange` committed and checked |
| **V1 — Binary tokens** | V0 | A (V1); E, D strategy and C fixtures in parallel | V1 acceptance |
| **V2 — Trading protocol** | V1 | A (V2); E | V2 acceptance; R checklist ticked |
| **V3 — Engine and liquidity (local)** | V2 | E, D | E and D acceptance on a local validator |
| **V4 — Devnet** | V3, Devnet SOL | D scripts, C live | §13.3 complete with a separate NO validation, recorded in `docs/v2-devnet-verification.md` |
| **V5 — App replaces v1** | V4 | C | v1 tagged `v1.1-demo`. `/` is the exchange. The production build passes |
| **V6 — Phantom rehearsal** | V5 | C polish, P | The full §11 flow in a browser, twice, from `prepare-demo-v2.ts` |

**Hard rule:** nothing reaches main that breaks the v1 tests or the v1 fallback demo before V5.

## 6. Human-only tasks

Approve D1–D7 · hold keys and fund the deployer · deploy and run setup scripts · map-check nothing new (same properties) · click through every flow in Phantom · rehearse.

## 7. Integration risks

| Risk | Mitigation |
|---|---|
| Transaction size or compute limits on multi-level fills | Level limits frozen at V0, plus a size test in A. Add a compute-budget instruction |
| Bots cross the book during the demo | Post-only clamp property test. The keeper is idempotent |
| Keeper down on stage | Limit orders match in the presenter's own transaction (§5.5). The keeper only clears races |
| Order cancelled between quote and signature | The whole transaction fails, then the UI re-quotes once |
| Devnet SOL shortage for a new program | Request from V0. v1 stays deployed as the fallback |
| RPC rate limits on `getProgramAccounts` | Chainstack primary, official fallback, 2 s cache |
| Outcome leak from earlier rounds | Homepage shows the latest round only. The replay disclosure is always visible |
