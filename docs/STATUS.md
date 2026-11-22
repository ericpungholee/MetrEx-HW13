# MetrEx status

Updated November 21, 2026. The active product is the four-market exchange. The frozen RFQ program and its historical claim recovery remain available.

| Hazard | Active residential property | Property ID | Presentation market (168-hour window) |
|---|---|---|---|
| Wildfire | 16185 Sunset Boulevard | 7 | [Round 29 market](https://explorer.solana.com/address/CUoYregFCPbuzNoZatUosRGKAbRhF6JSpAGrvheuBWby?cluster=devnet) |
| Hurricane | 4835 University Drive | 8 | [Round 30 market](https://explorer.solana.com/address/5Nr6MhS7GG92gghwbiZabtw9pgNeG4KPnn8aqUSXvPE2?cluster=devnet) |
| Earthquake | 214 Auberge Path | 9 | [Round 31 market](https://explorer.solana.com/address/KxpWoqJniGPu6cPZsVmHw2bRwWhPGnYeLhNXmceNmEy?cluster=devnet) |
| Tornado | 7007 Peckham Street | 6 | [Round 32 market](https://explorer.solana.com/address/C6JMinFDwZvoMAXUV7vS7y3EDQY34MdKs4qUV23tUt2z?cluster=devnet) |

Reset Demo opened these four rounds on November 21, 2026. Trading ends on-chain between 6:07:25 and 6:08:03 p.m. Toronto time on November 28, 2026 (168 hours). Restarts never move a deadline. At the deadline the supervisor settles through the oracle and the market stays featured, settled, until the operator resets it. Do not settle or reset these presentation markets.

Program [metrex_exchange](https://explorer.solana.com/address/BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko?cluster=devnet) · [Config](https://explorer.solana.com/address/786Mr9aEboyAe26Q91mPXpWA92KmsdtGivCkG15aaY2E?cluster=devnet) · [mUSD](https://explorer.solana.com/address/6cb8kKLX9hSfAeLGYxutmbadSckUfZ5cD8KyYZGNbTQC?cluster=devnet)

## Verification

- **Consolidation and data.** The active RFQ application, routes and workers are retired. Fresh property IDs replace the classroom and vacant parcel. All normalized datasets and residential sources reproduce from pinned inputs.
- **Financial and market independence.** Four Devnet markets traded and settled with matching evidence. YES, NO and an isolated Invalid market paid exact amounts. All 149 Anchor and 204 workspace tests passed. The disposable validator covered matching, multi-level execution, restart reconstruction and recovery.
- **Liquidity and readiness.** The three makers quote live on all four open rounds. One keeper and indexer process runs. The retired local duplicate keeper was stopped and signer leases block duplicate startup. The hurricane Devnet fill demonstrated automatic replenishment. A clean restart reused all four market accounts, rebuilt the books and issued no duplicate maker orders.
- **Phantom.** The wildfire wallet approved purchases, a sale, resting escrow, cancellation and a 1 mUSD payout. Other hazards and Invalid used automated Devnet signers. The large-wallet claim path has regression coverage.

[Full transaction and test records](multiperil-verification.md) · [Operations and legacy recovery](operations.md) · [Historical development and old deployment evidence](v2-build-log.md)

## V7 market simulation and demo operations (live on Devnet)

Spec: [spec-simulation.md](spec-simulation.md). Run: `METREX_SIM=1 SIM_TRADERS=100 SIM_RATE=2.5 pnpm demo` with `METREX_ORACLE_DATA_DIR` set for the supervisor. Operator controls are on password-protected `/operator`. Detail: [v2-build-log.md](v2-build-log.md#v7-final-integration-and-demo-readiness--november-21-2026).

- **Population.** 100 seeded traders (35 retail, 25 homeowners, 20 risk investors, 10 quants, 7 momentum, 3 large), 3,132,034 mUSD of finite capital, fees paid by one sponsor. Provisioning is idempotent and journaled. Reruns mint nothing to funded wallets. Each trader has a share-holding cap per outcome, so sub-cent YES prices cannot ask the makers for millions of shares.
- **Makers.** Three adaptive makers hold `MAKER_CAPITAL` = 1,500,000 mUSD each. It was raised from 600,000 by one journaled mint of 900,000 per maker, after warm-up showed four markets locked 600k. The makers may hold up to four times their split size per market (`BOTS_INVENTORY_MULT`).
- **Fast-forward.** Atomic `close_round` and oracle `resolve_market` at confirmed commitment. Rehearsed on wildfire round 19: redeemable in 2.2 s, finalized in 2.7 s, full settlement with closure proof and sweep in 20 s. A 40,000-share YES position redeemed for exactly +40,000 mUSD. The other markets kept trading.
- **Reset Market.** Round 19 became round 23 in 24 s with a fresh 168-hour deadline, and no other market changed.
- **Reset Demo.** Run twice. The second (final) run, with live workers, took 200 s:
  - The hold was acknowledged in 4 s, and three rounds were redeemable in about 5 s each.
  - 66 redemption transactions ran, with emptied simulated accounts closed back to the sponsor.
  - 42 wallets were minted 944,551 mUSD, 28 were burned 944,551 mUSD, and 33 were already exact.
  - Rounds 29–32 were created.
  - Human and judge wallets were not touched.
- **Natural expiry.** A 180-second rehearsal round (hurricane 28) settled through the oracle at its deadline. No replacement opened, and it stayed featured as settled.
- **Warm-up (final markets, 100 traders, 23:47–00:47 UTC).**
  - Throughput: at `SIM_RATE=2.5`, 271 confirmed simulated fills in 15 min, about 18/min. Individual minutes ranged 1–32, and the volume was 152k mUSD. At 1.6, 404 fills came in 30 min (about 14/min after the first burst). That is under the 20/min target on average. The cap is the RPC provider: 668 rate-limited requests in 15 min, all retried. 10.6% of attempts were rejected at preflight for stale quotes and cost no fee.
  - Liquidity: a 50,000-share YES market buy was fillable in 58 of 60 one-minute samples across the four books, costing 55–1,527 mUSD. 2-second sampling on wildfire and hurricane showed it fillable 97% and 93% of the time. The gaps last seconds while makers requote.
  - Prices moved with flow: the wildfire YES ask went from 1.43¢ to 0.96¢, hurricane from 1.56¢ to 2.91¢, earthquake from 0.22¢ to 0.11¢, and tornado from 0.34¢ to 0.30¢.
  - Maker A's free mUSD fell to about 96k (B 738k, C 1.06M). When A runs dry, B and C still post 70k YES per book.
- **Tests.** 149 Anchor tests, 240 workspace tests, type checks and the production build pass.
- **Resilience.** Transient RPC 5xx/429 errors no longer stop a worker (`surviveTransientRpcErrors`). Startup readiness requires one maker on each side of each book and reports what is missing.
- **SOL.** Over 99 minutes, including one-time account rent, the sponsor spent 0.40 SOL. Steady-state use at `SIM_RATE=2.5` is about 0.00055 SOL/min, about 0.8 SOL per week, against 4.68 SOL held. Each maker uses about 0.66 SOL per week and holds 1.38 SOL. Simulated accounts' rent returns to the sponsor at settlement.
- **Open.** The buy, fast-forward and redeem path was rehearsed with the homeowner demo key standing in for Phantom. No Phantom wallet has signed on rounds 29–32. Fast-forward during the presentation settles that one market; afterwards use Reset Market for it.

## Limits

- The Devnet program keeps its 30-day round limit and fixed replay scenarios. The seven-day advance window plus a full live calendar month would require approved protocol and data changes. The active replay creates independent market accounts with published historical windows and separate on-chain timelines.
- One host-local lease protects each signer identity. No unexpected signer activity appeared in the observed fresh rounds. An external host with a copy of a signer key would require owner-authorized rotation.
