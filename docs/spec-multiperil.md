# MetrEx multi-peril addendum

_Status: merged into `main` and deployed to Devnet on 2026-11-21._

This addendum extends [spec-v2.md](spec-v2.md) from one wildfire to four property markets, one per peril. Everything spec-v2 says still holds unless a section here replaces it. Section numbers (§) in code comments that cite `spec-multiperil.md` refer to this file.

The owner approved these choices on 2026-11-21:

- a small program upgrade (scenario IDs 1–4, and concurrent rounds of different hazards), with no account layout, seed, instruction, argument, error or event changes;
- a real earthquake (the 2014 South Napa M6.0) for the earthquake market;
- free illustrative imagery for the cards (§7.3);
- real home addresses for the four catalog markets (§3), chosen from OpenStreetMap without using any damage data.

## 1. Product

Each market asks one yes-or-no question about one property and one calendar month. Examples: "Will 16185 Sunset Boulevard be affected by a wildfire this January?" and "Will 7007 Peckham Street be affected by a tornado this May?". YES pays 1 mUSD per share when the pinned trigger is met. Buying YES is parametric protection: it pays on the event, not on damage. NO holders supply the collateral and earn the premium.

Every market is a **historical replay**. The question is written as if the month were still ahead, but the coverage month is in the past and the settlement data already exists. The app says so on every card and market page (§7.1). The oracle's data stays private until finalized settlement (spec-v2 §9).

Trading, collateral, the order book, portfolio and redemption are the same for every peril. Only the oracle adapter (§4), evidence (§5), bot quotes (§6) and display text (§7) differ.

## 2. Program changes (`metrex_exchange`)

The change is limited to scenario validation and the round-opening rule. There are no account layout, PDA seed, instruction name or argument, error code or event changes. `MAX_TAKE_LEVELS` and `MAX_MATCH_LEVELS` are unchanged. The IDL diff adds three constants, plus one doc-comment change.

| Scenario | Constant | Hazard | Trigger convention |
|---|---|---|---|
| 1 | `SCENARIO_PALISADES_2025` | Wildfire | `trigger_distance_m > 0` (distance to footprint) |
| 2 | `SCENARIO_HURRICANES_2017_09` | Hurricane | `trigger_distance_m == 0` (inside the swath) |
| 3 | `SCENARIO_SOUTH_NAPA_2014_08` | Earthquake | `trigger_distance_m == 0` (intensity at a point) |
| 4 | `SCENARIO_IOWA_TORNADOES_2024_05` | Tornado | `trigger_distance_m > 0` (distance to track) |

- `register_property` accepts scenarios 1–4 only (`UnsupportedScenario`). A point scenario (2 or 3) needs a trigger distance of 0, and the others need one above 0. Any other value fails with `InvalidTriggerDistance`.
- `create_round` accepts scenarios 1–4 and no longer requires the previous round to be closed. The `previous_round` account stays in the instruction and is optional, so the interface is unchanged. `PreviousRoundOpen` stays in the error enum but is no longer returned.
- `create_market` still requires the property's scenario to equal the round's (`ScenarioMismatch`).
- Prices are already `u16` basis points in 1–9,999, so 1 bps = 0.01¢ and fractional-cent prices need no program change. `quote = quantity × price_bps × 100` stays exact.

### 2.2 Concurrent rounds: guarantee vs. policy

Rounds of different hazards may be Open at the same time, each with its own `trading_ends_at`. Closing one round stops trading only on that round's markets. Resolution, expiry and invalidation stay per market, so the operator can close and settle each hazard independently.

| Guaranteed by the program | Policy of MetrEx's operator and scripts |
|---|---|
| A market trades only while **its own** round is Open, before **its own** deadline, and unresolved (I6, per round) | **One Open round per hazard.** `scripts/prepare-multiperil.ts` and `prepare-demo-v2.ts` settle a hazard's stale round before opening its next one |
| A market's property scenario equals its round's scenario | Which round the homepage features for each hazard (the newest round of that scenario containing the catalog property) |
| Every spec-v2 §5.10 guarantee, per market | The contract month, question and trigger text shown for a market (catalog display data) |

`Config.latest_round` now means "the most recently created round", not "the only round". The homepage no longer reads it (§7.2). The `/rounds` list and the portfolio look back 8 rounds.

## 3. Properties

**The owner asked for real addresses (2026-11-21).** Each catalog market is a real residential address point from OpenStreetMap, chosen by `scripts/find-real-properties.ts` and written to `data/market-properties.json`. The raw Overpass responses are saved under `data/raw/osm-addresses/` and pinned by SHA-256 in [data/DATASET-hazards.md](../data/DATASET-hazards.md), so the choice can be rerun offline.

**Selection rules:**
- A candidate needs `addr:housenumber` and `addr:street`, plus residential evidence: a house, detached, residential, terrace, bungalow or apartments building tag, or a bare address point.
- Shops, offices, amenities, named businesses and ambiguous `building=yes` are excluded.
- **No damage data picks a property.** Any element with `damage:*` or lifecycle tags (destroyed:, razed:, …), which come from post-fire damage inspections, is excluded. DINS records are never used.
- Each candidate is evaluated exactly as the oracle will, at its integer micro-degree point.
- The qualifying address nearest the search anchor wins, ties broken by OSM type and id.
- The label `<number> <street>` must fit the 32-byte on-chain label.

| ID | Address (on-chain label) | Place | OSM element | Scenario | Trigger | Outcome margin |
|---|---|---|---|---|---|---|
| 7 | 16185 Sunset Boulevard | Pacific Palisades, California | relation/6181038 (apartments) | 1 | 500 m | inside the final footprint (125 m in). Flipping to NO needs ≥ 500 m more, since the trigger reaches 500 m past every ring |
| 4 | 1111 Memorial Drive | Coral Gables, Florida | node/6014195094 | 2 | 0 | 18,681 m outside every 64-kt swath (rule ≥ 10 km) |
| 5 | 909 Stanly Way | Napa, California | node/11689072992 | 3 | 0 | MMI 8.2 at the nearest node (378 m). Every node within 750 m ≥ 8.0 |
| 6 | 7007 Peckham Street | Johnston, Iowa | way/1340970761 (house) | 4 | 500 m | 64 m from an EF2+ centerline (rule ≤ 150 m) |

The wildfire and Napa margins are narrower than the earlier lattice picks (≥ 300 m from every ring, and every node within 1.5 km). OSM has no damage-free Palisades home that far inside the footprint, and too few Napa address points to clear 1.5 km. The rules above are what the script enforces and the tests check.

Every market pays on hazard proximity or measured intensity. It says nothing about damage to the home or its residents, and the app says so on the homepage and in the footer. Map data © OpenStreetMap contributors, under the ODbL.

Properties 1–3 (fictional v1/v2 wildfire points, such as "Palisades · Home #1042") stay registered and unchanged. They belong to earlier rounds and the `/v1` demo, not the catalog.

## 4. Hazard datasets and oracle adapters

Each dataset is a normalized file in `data/`. It is produced by `scripts/normalize-hazards.ts` from raw downloads whose SHA-256 the script pins. Its hash goes into `data/scenarios.json` and, at round creation, into `round.dataset_sha256`. Sources, raw hashes and download URLs are in [data/DATASET-hazards.md](../data/DATASET-hazards.md).

Every file carries a `metrex.rule` object, so the rule is covered by the same hash as the data:

| Field | Meaning |
|---|---|
| `hazard`, `method` | `hurricane`/`inside_footprint`, `earthquake`/`nearest_node_intensity`, `tornado`/`track_proximity` |
| `threshold`, `threshold_x10` | Human-readable threshold and its integer form (MMI × 10 for earthquakes) |
| `coverage_start`, `coverage_end` | UTC instants of the local calendar month, `[start, end)` |
| `timezone` | IANA zone used for the month boundaries |

| Hazard | Rule | Coverage window (UTC) |
|---|---|---|
| Hurricane | Inside any NHC best-track 64-kt wind swath piece whose storm overlaps the month | 2017-09-01T04Z → 2017-10-01T04Z (America/New_York) |
| Earthquake | USGS ShakeMap MMI × 10 at the nearest grid node ≥ 80 | 2014-08-01T07Z → 2014-09-01T07Z (America/Los_Angeles) |
| Tornado | Geodesic distance to any surveyed EF2+ centerline that started in the month ≤ `trigger_distance_m` | 2024-05-01T05Z → 2024-06-01T05Z (America/Chicago) |

The wildfire scenario keeps its v1/v2 perimeter file and rule (`packages/geo`, evidence v2).

### 4.3 Missing coverage is refused, never settled NO

The oracle refuses to resolve, and never resolves NO, when:

- the dataset bytes differ from `round.dataset_sha256`;
- the dataset's `metrex.rule` contradicts the property (for example a nonzero trigger on a point method, or a scenario mismatch);
- for an intensity grid, the nearest node is more than 1,000 m from the property or the property lies outside the grid (not covered).

A refused market stays unresolved. The existing recovery paths apply: `invalidate_market` (admin and oracle) or `expire_market` (anyone, at or after `T`), both paying 0.5 mUSD per share.

## 5. Evidence and pricing

- Scenarios 2–4 publish **evidence v3**: canonical JSON (sorted keys, no whitespace, integers only), SHA-256 hashed, with `version: 3`, `hazard`, `scenario_id`, `round`, `market`, the property, the dataset hash and the pinned `coverage` window. It also carries the method's computed integers (`distance_m`, or `mmi_x10` and the node, or `inside`) and `triggered`.
- Scenario 1 keeps evidence v2 unchanged.
- Every exchange market page shows a map of the registered point and, for distance-based markets, its on-chain trigger radius. After finalized YES/NO settlement, `?overlay=1` on the evidence route serves the matched dataset's wildfire perimeter, hurricane wind swaths, tornado centerlines or ShakeMap grid points. The ShakeMap layer marks the nearest node and distinguishes samples above and below the threshold. Invalid markets have no historical overlay. The legacy `?perimeter=1` response remains available.
- Prices display in cents with up to two decimals (80 bps = 0.80¢; 415.5 bps average = 4.155¢). Entry accepts cents ("0.8", "0.80¢").

## 6. Per-market bot ladders

`packages/exchange/src/catalog.ts` holds one ladder per catalog market. These are starting quotes for MetrEx-operated makers, not premiums, forecasts or actuarial estimates. Skew is off, NO is the exact complement of YES, and the ladders never cross. The bot worker uses `ladderFor(propertyId, scenarioId, bot, fallback)`, and other markets keep the shipped `DEMO_BOTS` ladder.

| Market | A (ref ± half) | B | C | Sizes A/B/C | Split pairs |
|---|---|---|---|---|---|
| Wildfire #1 | 80 ± 6 | 90 ± 10 | 100 ± 18 | 60k / 40k / 30k | 60k |
| Hurricane #4 | 120 ± 9 | 135 ± 15 | 150 ± 27 | 60k / 40k / 30k | 60k |
| Earthquake #5 | 10 ± 1 | 10 ± 2 | 11 ± 4 | 60k / 40k / 30k | 60k |
| Tornado #6 | 30 ± 2 | 34 ± 4 | 38 ± 7 | 60k / 40k / 30k | 60k |

At zero inventory the four markets commit about 480k (A), 400k (B) and 360k (C) mUSD, mostly NO-bid escrow and split collateral. `fund-bots.ts` tops each bot up to 600k mUSD.

## 7. Frontend

### 7.1 Required text

Every market page shows the contract details in plain text:

- its payout rule. The wildfire sentence is the verbatim spec-v2 §10.1 text. Every other rule names its source and threshold and ends "…, not on damage.";
- the historical coverage month, the separate Devnet trading deadline, the settlement source and the invalid-outcome terms beside the ticket.

This replaces the standalone replay and liquidity paragraphs from spec-v2 §10.1. Market makers retain their labels in trades. The map carries OpenStreetMap attribution and each photo carries its credit.

### 7.2 Homepage

The homepage shows the four catalog markets in a 2×2 grid on desktop and a single column on phones. Cards show regional photography, the market question, historical contract month, finalized volume when available, and separate YES and NO actions. `GET /api/featured` selects each market and supplies its best YES ask. The NO ask comes from the NO order book. Selecting an outcome opens the market with that side selected in the trade ticket. A closed or settled market shows its state.

The market detail page shows the live asks, with labelled midpoint or last-trade prices when an ask is unavailable. The price chart lets viewers switch between finalized trades and quoted midpoint history and filter either series by time. The rules show the historical month, settlement source and the separate Devnet trading deadline.

### 7.3 Imagery

Cards and market headers label their images as area photos and link to their source and license. The images show the surrounding regions. [Photo credits](market-photo-credits.md) lists the local WebP assets, authors and licenses.

### 7.4 Coverage mode

The trade panel has **Buy coverage** and **Trade shares** modes. Coverage mode buys YES at market for a dollar coverage amount (1 share = $1 of cover, with presets of 25k, 50k, 100k and 250k). It displays estimated monthly cost, potential payout and any partial-fill warning. Trade mode displays the estimated cost or proceeds and the effect on potential payout. Execution details show the price tolerance, estimated fills, applicable escrow and the worst accepted price on a market order. The default tolerances remain 100 bps for coverage and 200 bps for share orders.

### 7.5 Portfolio

The portfolio shows available mUSD, estimated sale proceeds for available shares in open markets, claimable mUSD and open orders. Estimates use the available bids within the market order fill limit and show when depth or quote coverage is partial. **Active protection** lists unresolved YES positions, their historical coverage month, potential payout and net YES cost from indexed finalized fills. Positions show the average indexed purchase price where available. The portfolio looks back 8 rounds.

### 7.6 Operator

`/operator` opens with the four catalog rounds and offers earlier rounds on demand. The operator selects a round and runs close → reject proof → resolve → sweep → status on that round only. The server route already takes a round address.

## 8. Tests

- Anchor: a "multi-peril" block covers registration conventions, three concurrent rounds of different scenarios, scenario binding, a 1 bps quote, and closing one round while the others keep trading. The old "second Open round is rejected" test was removed, because the rule is now policy (§2.2). On 2026-11-21: 149 passing (v1 and v2).
- `packages/geo`: dataset rules and hashes, the three demo properties' margins, refusal of uncovered points, evidence v3 determinism.
- `packages/exchange`: catalog ladders (12 levels, no crosses, no complement arbitrage, labels ≤ 32 bytes) and `ladderFor` fallback.
- `scripts/normalize-hazards.ts --check` rebuilds all three files from pinned raw bytes and compares hashes.

## 9. Out of scope

Real-time or forward-looking hazard feeds, live government API calls at runtime, damage-based triggers, more than one property per hazard in the catalog, and on-chain enforcement of one Open round per hazard (that would need an account layout change).
