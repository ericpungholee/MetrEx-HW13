# MetrEx status

Updated November 21, 2026. The active product is the four-market exchange. The frozen RFQ program and its historical claim recovery remain available.

| Hazard | Active residential property | Property ID | Fresh Devnet market |
|---|---|---|---|
| Wildfire | 16185 Sunset Boulevard | 7 | [Round 19](https://explorer.solana.com/address/9Q3bfXXEefR2LC6zCzxYUuAm6tAJmpk5zqtP28RicDKy?cluster=devnet) |
| Hurricane | 4835 University Drive | 8 | [Round 20](https://explorer.solana.com/address/3CMErSDZEscKoSpsW7Zf514ebLESkRtrNLcx1NT7g9Fe?cluster=devnet) |
| Earthquake | 214 Auberge Path | 9 | [Round 21](https://explorer.solana.com/address/ShbtjDupTGnLVvo9uU4wSvi1V7WCwoYJLRX3jdr8sEL?cluster=devnet) |
| Tornado | 7007 Peckham Street | 6 | [Round 22](https://explorer.solana.com/address/2HAohyf3CAQNcPXcgC5e6nZR7KBvph99M5Nmy4jeXq2H?cluster=devnet) |

Round deadlines fall between 3:21:09 and 3:21:17 p.m. Toronto time on November 23, 2026. The operator may explicitly close any replay sooner.

Program [metrex_exchange](https://explorer.solana.com/address/BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko?cluster=devnet) · [Config](https://explorer.solana.com/address/786Mr9aEboyAe26Q91mPXpWA92KmsdtGivCkG15aaY2E?cluster=devnet) · [mUSD](https://explorer.solana.com/address/6cb8kKLX9hSfAeLGYxutmbadSckUfZ5cD8KyYZGNbTQC?cluster=devnet)

## Verification

- **Consolidation and data.** The active RFQ application, routes and workers are retired. Fresh property IDs replace the classroom and vacant parcel. All normalized datasets and residential sources reproduce from pinned inputs.
- **Financial and market independence.** Four Devnet markets traded and settled with matching evidence. YES, NO and an isolated Invalid market paid exact amounts. All 149 Anchor and 204 workspace tests passed. The disposable validator covered matching, multi-level execution, restart reconstruction and recovery.
- **Liquidity and readiness.** The three makers quote live on all four open rounds. One keeper and indexer process runs. The retired local duplicate keeper was stopped and signer leases block duplicate startup. The hurricane Devnet fill demonstrated automatic replenishment. A clean restart reused all four market accounts, rebuilt the books and issued no duplicate maker orders.
- **Phantom.** The wildfire wallet approved purchases, a sale, resting escrow, cancellation and a 1 mUSD payout. Other hazards and Invalid used automated Devnet signers. The large-wallet claim path has regression coverage.

[Full transaction and test records](multiperil-verification.md) · [Operations and legacy recovery](operations.md) · [Historical development and old deployment evidence](v2-build-log.md)

## Limits

- The Devnet program keeps its 30-day round limit and fixed replay scenarios. The seven-day advance window plus a full live calendar month would require approved protocol and data changes. The active replay creates independent market accounts with published historical windows and separate on-chain timelines.
- One host-local lease protects each signer identity. No unexpected signer activity appeared in the observed fresh rounds. An external host with a copy of a signer key would require owner-authorized rotation.
