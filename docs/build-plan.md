# MetrEx — Build Plan (v1.1)

> **v1 plan; all gates passed.** v2 work follows [build-plan-v2.md](build-plan-v2.md).

**Builds:** `claude/metrex-spec-v1.1.md` (put a copy at `docs/spec.md` in the repo; every agent reads it)
**Team:** one human + parallel coding agents
**Target prize:** MLH Best Use of Solana (Unruggable hardware wallets). The brief rewards fast, cheap, high-frequency transactions and trading/DEX designs, so the plan includes **Tier 2** (secondary trading, continuous requoting, live network stats) as planned work, not a stretch.

Work is ordered by dependency gates, not by clock. Move to the next gate as soon as the current one passes.

---

## 1. Operating model

You're the **integrator**. Agents write the code; you freeze interfaces, launch workstreams, review against acceptance criteria, merge, and do everything that needs a wallet, a human eye, or a judgment call.

1. **Freeze interfaces first (Gate 0).** Account layouts (including Tier 2's `Listing` and the holder fields), instruction signatures, PDA seeds, constants and shared TS types are written once, compiled and committed before any workstream starts. After that, only you change them.
2. **One directory per workstream**, one worktree/branch per agent, merge only at gates with tests passing.
3. **The spec wins.** If an agent thinks the spec is wrong, it stops and reports instead of improvising.
4. **No secrets in git.** Keypairs in `~/.config/metrex/*.json`; `.env.example` only.
5. **Fresh-eyes review.** The program is audited by an agent that didn't write it (R), after Gate 1 and again after Tier 2.

---

## 2. Repository layout (owned by)

```text
metrex/
├── docs/spec.md                     # you
├── Anchor.toml, Cargo.toml          # Gate 0
├── programs/metrex/src/             # A: lib.rs, state.rs, errors.rs, constants.rs, instructions/*.rs
├── tests/metrex.ts                  # A
├── packages/shared/src/             # Gate 0, then frozen: constants, pda, types, scenarios, evidence-schema
├── packages/geo/src/                # B: evaluate, canonical, evidence (+ tests)
├── data/                            # B: palisades-2025.geojson, scenarios.json, DATASET.md, evidence/
├── app/                             # C: Next.js (pages, components, lib/client.ts)
├── app/app/api/                     # D: oracle/resolve, demo/close, stats route handlers
├── services/bots/                   # D: bot worker (+ requoting in T2)
├── services/indexer/                # D: program tx stats for the network panel (T2)
└── scripts/                         # D: setup-devnet, fund-bots, fund-wallet, seed-demo; B: find-properties
```

pnpm/npm workspace so `app`, `services` and `scripts` import `@metrex/shared` and `@metrex/geo`.

---

## 3. Gate 0 — interface freeze

**You (in parallel with G0):**
- [ ] Install/verify Solana CLI and Anchor via avm; pin the Anchor version and the matching client library.
- [ ] Generate keypairs: `admin`, `oracle`, `controller`, `bot-a/b/c`, `homeowner-demo`, `judge-1..3`, `deployer`.
- [ ] Request devnet SOL for `deployer` and `admin` early and repeatedly; deploys need several SOL and faucets rate-limit.
- [ ] Download the Palisades final perimeter (CAL FIRE / NIFC) by hand into `data/raw/`; agent sandboxes may not reach government sites.
- [ ] Copy the spec to `docs/spec.md`.

**Agent G0 — scaffold + freeze:**

> Read `docs/spec.md` §4–6 (including Tier 2 rows, §5.6 and the holder fields) and §15. Scaffold the workspace in the build plan §2. In `programs/metrex`, write compiling stubs: every account struct with all fields and `InitSpace`; every instruction (core and Tier 2) with its full `Accounts` context (seeds, constraints, signers) and an empty body; the error enum; constants. Run `anchor build` and commit the IDL. In `packages/shared`, write constants, PDA helpers for every seed in §5, TS types mirroring the accounts, the scenario registry type and the evidence JSON type (§8.4). Add `.env.example` and `.gitignore`. No business logic.

**Exit:** `anchor build` passes; IDL committed; `@metrex/shared` builds; you've checked structs and seeds against the spec. **Freeze.**

---

## 4. Workstreams

### A — Program + tests

> Implement every core instruction per `docs/spec.md` §4–6 with the holder fields. Do not change layouts, seeds or signatures; if one is wrong, stop and report. Checked arithmetic, u128 premium math, mint and owner checks on every token account. Write `tests/metrex.ts` covering every core item in §12.1 plus a same-slot concurrent-offers test. Run `anchor test` until green. Then, in this order: Tier 2 (`list_position`, `buy_position`, `cancel_listing` and their §12.1 tests), then `void_market` + `refund_offer`.

**Core acceptance (Gate 1):** core tests green; every §6.3 invariant 1–14 has a named test; conservation passes for YES and NO.
**Tier 2 acceptance:** trading tests green; invariants 15–17 tested; a bought side claims correctly in both YES and NO.

### B — Geo, dataset, evidence

> From `data/raw/`, produce `data/palisades-2025.geojson` (WGS84, one MultiPolygon, holes kept), `data/scenarios.json` and `data/DATASET.md` (source, retrieval date, SHA-256 of raw and normalized files) per §8.1. In `packages/geo`, implement `evaluate()` per §8.2 with Turf (`booleanPointInPolygon` + `pointToLineDistance` over every ring), canonical JSON and `buildEvidence()` per §8.4, and unit tests for every §8.2 case on synthetic geometry. Write `scripts/find-properties.ts` and propose properties 1–3 meeting §8.3's margins, with distances recorded in `DATASET.md`.

**Acceptance:** tests green including both hole cases; evidence byte-identical across runs; three properties with recorded distances. **You** check the points on a real map before registering them.

### C — Frontend

> Build `app/` per §3 and §10: Next.js, TypeScript, Tailwind, Solana wallet adapter (Wallet Standard), dark exchange design. All chain access goes through `app/lib/client.ts` (reads: markets, offers, listings, balances; writes: createMarket, placeOffer, cancelOffer, acceptOffers[batched], claimAll[batched], listPosition, buyPosition, cancelListing) using `@metrex/shared` and the committed IDL. Until deployment, back reads with a labelled fixture behind `NEXT_PUBLIC_USE_FIXTURES=1`; production builds must fail with it on. Pages `/`, `/create`, `/market/[id]` (order book, positions table with holders and listings), `/portfolio` (exposure per scenario, bought positions), `/demo` (close, Leaflet map with perimeter + 500 m circle, resolve, evidence). Network panel (§10.5) on `/` and `/demo`. Display states §10.2, trigger wording §3.3, Explorer links `?cluster=devnet`, 3 s polling, readable error mapping.

**Acceptance:** every page renders against fixtures; switching to Devnet needs no UI changes; batched accept/claim builds one transaction for 3 instructions (auto-split if too large).

### D — Bots, oracle, controller, indexer, scripts

> Per §7, §7.1 and §9: `services/bots/` (3 bots, own keypairs, 3 s polling, idempotent, balance checks, cleanup cancels; then Tier 2 requoting within floors and rate limits, and Risk-side listings). Route handlers `POST /api/oracle/resolve/[market]` and `POST /api/demo/close/[market]` (server-only keys, demo password header; oracle uses `@metrex/geo` + scenario registry, refuses unknown scenarios and resolved markets). `services/indexer/` + `GET /api/stats`: program transaction count (total, last 10 min) and total fees from transaction metadata. Scripts: `setup-devnet.ts` (mint, Config, properties from `DATASET.md`), `fund-bots.ts`, `fund-wallet.ts <pubkey>`, `seed-demo.ts`. Idempotent scripts with Explorer links.

**Acceptance:** a new market gets three bot offers within 10 s; a judge undercut triggers bot requotes that stop at floors; close → resolve writes evidence whose hash matches on-chain; `/api/stats` matches Explorer counts for a sample.

### R — Security review (fresh agent, no prior context)

> You are auditing a Solana Anchor program you did not write. Read `docs/spec.md` §4–6 and `programs/metrex`. For each §6.3 invariant and each §6 instruction row, cite the line that enforces it or report that nothing does. Look for: missing signer/`has_one` checks, caller-supplied authorities, mint/owner checks, PDA seed confusion, double-claim/double-resolve, overflow, vault ≠ coverage after acceptance, substitutable accounts, and for Tier 2: stale listings, buying a side you can't pay for, holder changes without payment, trading after resolution. Write failing tests for findings. Don't fix; report.

You triage findings and send fixes back to A.

### P — Pitch and submission (chat with Claude)

Devpost write-up, slides from §11.1 plus a "Why Solana" slide built on the live network-panel numbers, demo cue cards, a 2-minute demo video plan.

---

## 5. Gates

| Gate | Needs | Workstreams running | Passes when |
|---|---|---|---|
| **0 — Freeze** | Toolchain, keys, SOL, raw data | G0 | IDL + shared package committed and reviewed |
| **1 — Core program** | Gate 0 | A, B, C (fixtures), R after | Core `anchor test` green; geo tests green; properties chosen and map-checked |
| **2 — Devnet live** | Gate 1 | D scripts; A fixes R findings | Program deployed; Config + 3 properties registered; bots and demo wallets funded |
| **3 — Human lifecycle** | Gate 2 | C integration (fixtures off) | You complete create → offer → accept → claim in your wallet on Devnet |
| **4 — Definition of Done** | Gate 3 | D bots + oracle; C `/demo` | Full YES and NO runs on Devnet with bots and oracle (§12.4) |
| **5 — Solana track (T2)** | Gate 4 | A trading; D requoting + indexer; C positions + network panel; R re-audit | A position changes hands on Devnet and the new holder claims; bots requote live; network panel shows real numbers |
| **6 — Demo-ready** | Gate 5 | C polish; P | §14 checklist ticked; fallback seeded; demo video recorded; rehearsed |

**Hard rule:** nothing in Gate 5 or 6 merges while Gate 4 is red. Tier 2 program code lives on its own branch until its tests and R's re-audit pass, so it can never break the core demo.

---

## 6. Human-only tasks

Hold keys and request SOL · download the perimeter if agents can't · map-check property points · deploy and run setup scripts · click through every flow in a real wallet (and a hardware wallet if you have one) · triage security findings · rehearse and present.

---

## 7. If something has to give

Cut in this order: void/refund → in-browser hash recompute → Leaflet map (use a static image) → bot Risk-side listings → property 3 → batching. Requoting and position trading go before anything in the core.

Never cut: the §6.3 invariants and their tests, YES **and** NO on Devnet, the trigger wording on the market page.

---

## 8. Integration risks

| Risk | Mitigation |
|---|---|
| Agent changes a shared interface | Frozen at Gate 0, including Tier 2 accounts; only you edit; regenerate IDL + types after any approved change |
| Tier 2 destabilizes core | Separate branch; merges only after its tests and R's re-audit |
| Anchor / client version mismatch | Pinned at Gate 0; agents never upgrade |
| Requoting bots spam or drain SOL | Rate limits and per-market caps in §7.1; SOL balance check before each tx |
| Devnet SOL shortage | Request from Gate 0 onward; keep a spare funded deployer |
| Devnet RPC flakiness | Backup RPC in env; seeded fallback market; recorded demo video |
| Fixtures leak into the demo | Production build fails if fixtures are on |
| Merge conflicts | One directory per workstream; merges only at gates |
