# MetrEx v2 — Devnet verification (Gate V4)

_Run 2026-11-21 on Solana Devnet, with every check repeated from chain state. Explorer links use `?cluster=devnet`._

Gate V4 requires spec-v2 §13.3: a real round, markets, splits, bot depth, a market buy, a limit order with a partial fill, a cancel, a round close with a rejected trade, YES and NO resolution with matching hashes, and redemptions checked to the base unit. Every item passed. NO was validated separately on property 2.

## Deployment

| Item | Value |
|---|---|
| Program | [`BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko`](https://explorer.solana.com/address/BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko?cluster=devnet) |
| Deploy tx | [`3CkiSLnE…`](https://explorer.solana.com/tx/3CkiSLnELYYGgbFEbyXSKLMCPL11xrupXphrPNBZLHt9G7Hug6wSdA1gN6H6VjBJBDXdpfDPup2JqFVtzWhiCanh?cluster=devnet), slot 524716530 |
| ProgramData | `HTkfXeQP1xauJKp2d65uo7NRo6y8jRFtBeWSMDxxgVK9`, 755,024 B, 3.83640076 SOL rent |
| Upgrade authority | admin `sQuXrM2LYdxq5sc8dAcsfgFSoa9V6jfNk5txzea87sD` (the deployer only paid fees) |
| Bytes | `solana program dump` SHA-256 `b9d0325e3de90d84f38a6815c04956ac7ef3e1fae2718c55b8a3da5de324966b`, equal to the locally tested `target/deploy/metrex_exchange.so` |
| Config | `786Mr9aEboyAe26Q91mPXpWA92KmsdtGivCkG15aaY2E`, collateral = the existing mUSD mint `6cb8kKLX9hSfAeLGYxutmbadSckUfZ5cD8KyYZGNbTQC`, resolution timeout 86,400 s |
| v1 | `AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X` untouched |

Setup (`setup-devnet-v2.ts`): [initialize_config](https://explorer.solana.com/tx/2KniW37kyDL4hBEsSDckJumjJ216cbD3hFfN9Q133UkzW51vjzgz5Gk5GJnDqSKBmsgTHGUrhyGe1PTFVoW9Dihr?cluster=devnet) · [property 1](https://explorer.solana.com/tx/3Lqe9ChahmayRLyENKCbMrw9448t8FJvKVzxaEqUXpZNGtpMyG6ZqwfhwyHWeaLVh6QMAkKS47sjnQ2tTCCzjZSS?cluster=devnet) · [property 2](https://explorer.solana.com/tx/3aTSvJtPXCXeG5ZEZjHQabHGzUcPPQbfMndekz4T8yxJ4WfSwStXyCP1DzQKj9YjKsCHRhWSiAJiR5vSjiM1PviZ?cluster=devnet) · [property 3](https://explorer.solana.com/tx/3Xr8ca2iM1iUrrnaouCtmjeFxqh4mwFkZL6z54iaF2zhUsvjcaFWhm4sWgbukPFqeeehgAu42KPZpbzV1NG3PPSS?cluster=devnet)

Funding (`fund-bots.ts --from deployer`): [SOL](https://explorer.solana.com/tx/3tbgUwqR236RJBXZGneQDV2qsg5PrBHcDyMpcA5hQ9pSqz4vV7ioKYKMLbMX3Ty1SqNU66tEC6ayKWSFwSsYgkGB?cluster=devnet) · [mUSD mints](https://explorer.solana.com/tx/3wPRPNUmS6tGp9wjd9D2XWXxdzEqe1JMddCdYbjS1v2XF19aUADA4hKnVb7CTFCPbQJXfLh7XmuctZdaP2m1AveJ?cluster=devnet)

**Funding source.** 20 Devnet SOL came from DevnetFaucet.org into the deployer ([tx](https://explorer.solana.com/tx/3EMZWeYqnJpFwfjgmCANxXy1hDcfE3P2TUbSZLNPW9cj8XxGPytLvTvZPibYkRuFiQB8EFZZZZsdEAF9FJGpCtW1?cluster=devnet)). Other faucets were rate-limited or required a Mainnet balance. The deployer paid the deploy (about 7.7 SOL at peak, 3.84 SOL locked) and funded admin 0.5, keeper 0.5, controller 0.2 and oracle 0.2. It holds 12.63 SOL afterwards.

## Round 1 (`prepare-demo-v2.ts`, bots and keeper running)

- **Round and markets:** [create_round #1](https://explorer.solana.com/tx/3gsghgPVmaQk68cqP5VQk3zJQCfT71jCKURqSQTNGcyaTSmYgMrwWGzmAHisuzLwGiSEkixc853d6Me5LcTjp5Y1?cluster=devnet) `8W7577Wu3uUXKAQ8xRNHaGmZsjgMmwnCneNABY3zQ8Kk`, labelled "Palisades replay #1" and committing dataset SHA-256 `8447bc02…`. Markets: [property 1](https://explorer.solana.com/tx/5y8nq15wLD2Wv745heU7QTmfQN4rwN9vJiK1K7j9YRWHVot9ssEoPvn84EzKrC9N6yUg1pGfrXrPNR9hywA5zyDb?cluster=devnet) `5SzXBhtCYT4vAfozct8GoRb2bcKEF7tcZyqU4AT5SjNo` and [property 2](https://explorer.solana.com/tx/u3WFmBWwhrfiRBM77zNzgHfMt9f7wyHTexWzQ1UjXSPfUA38MxmTaQu9fS5R6xTmWSFmhaKF3wqcJzNdGLdEpC3?cluster=devnet) `DoxeTzJuwXe8F2iNryHYPedYyYyhk23tHrUHW6Luo57K`.
- **Bot depth:**
  - Three bots quoted both books of both markets with no crosses.
  - The §8.3 ladder on property 1 was exact: YES bids C 100 @ 410, B 150 @ 400, A 200 @ 370; asks A 200 @ 430, B 150 @ 500, C 100 @ 590; and NO at the exact complements.
  - Quotes were complete 14.6 s (property 1) and 18.6 s (property 2) after market creation. Locally this took 5.7 s. The difference comes from the RPC provider's 429 rate limiting (see Risks).
- **Heartbeats** were live, and the oracle dataset matched `round.dataset_sha256`.

## §13.3 trades (`prove-v4-devnet.ts --phase trade`, presenter wallet)

| Step | Result | Tx |
|---|---|---|
| Split 10 | −10,000,000 mUSD base units, +10 YES, +10 NO | [4N5hbhyR…](https://explorer.solana.com/tx/4N5hbhyRcjh6fNkk71MaMM95soxeSaEooVnrxsrRsKAfh6Dv4gaWjvNv7ubkZin23HggPRobvY6gc4HEqVZsLfet?cluster=devnet) |
| Merge 10 | +10,000,000 back, YES and NO 0, mUSD equal to the base unit | [3c4QL5Tg…](https://explorer.solana.com/tx/3c4QL5TgenspXRTLqpQq6ggW6gAKJk3vv3k9zBdMo4ToyX8JXR8wAtxu9rhbNUocWAKM54Ens6vp9Q6EsCfwwne9?cluster=devnet) |
| Market buy 300 YES (one signature) | A 200 @ 430 + B 100 @ 500 = exactly 13,600,000; holds 300 YES | [2fWsVMcY…](https://explorer.solana.com/tx/2fWsVMcYowijKXmzmnspqtBD3YgeNvcvv6ohCnCkonrN4t9SWMk1ED9SV3WTQJ7S8yFmcbJHGH2UiQmcTVweQFeA?cluster=devnet) |
| Limit sell 200 @ 410 (place + match in one transaction) | Partial fill: 100 against Bot C's 410 for 4,100,000; 100 rests | [jnwGP8h4…](https://explorer.solana.com/tx/jnwGP8h4uCKt9FD2Fmqsu8ZQji4mdX7DcUBKjxsdtksBzLQ7kK1df2RyJ24pNi3gppHp2F9NM2BFgYf4T4MXMe9?cluster=devnet) |
| Cancel the resting 100 | 100 YES escrow returned (wallet 200 YES), order closed, +2,773,760 lamports net rent | [2za9tVx9…](https://explorer.solana.com/tx/2za9tVx9ry6rQoVtnaUbn28qTFXYWMnZmeVff8MKt8fHCyHrUsposdMQH3369LetWCWyp74B7uv3XBxPcEwMswyq?cluster=devnet) |
| NO: market buy 50 NO on property 2 | C 50 @ 9,590 = 47,950,000 (= q × bps × 100); holds 50 NO | [3EtagcTy…](https://explorer.solana.com/tx/3EtagcTysEHddYZA6UZfQMDMo9ia7gTXu64w6VCUzzsvSRn8STkfrL2vjcC3GZsZ21pu9QezP2roRR526Y2SLEN6?cluster=devnet) |

## Settlement (second `prepare-demo-v2.ts`, then `prove-v4-devnet.ts --phase settled`)

The second prepare run found round 1 stale, because it had a non-bot wallet. It then ran these steps:

1. [Closed round 1](https://explorer.solana.com/tx/3uvaW4SQyLJgKCx7C2D3PjZZ7jVpYc6jPTKkeFUDjeji8hnEUoM5QP81s1epsowpSFUqqgas4baK3T2SQsm1zdM6?cluster=devnet). One close stopped both markets.
2. The oracle resolved both markets. It checked the on-chain round gate and the dataset hash first, and only after that evaluated the dataset.
3. Swept the 8 remaining orders on property 1 ([sweep](https://explorer.solana.com/tx/2zY1pq9VjcZia8ecisdHZ5ZUq5H3ybpcwLLU6PaSvLnaaLXEcwQpE2vLXe5RMSZC1CJvQhZxAY3k5u7BMC72JKht?cluster=devnet)).
4. Opened [round 2](https://explorer.solana.com/tx/2z9ZyvquA9L26ZPGSHg2A3o5NPe5ZWyHpRCzyYTq5MdRzNpzKoRyQydZLsJzGMceyrk2scUhy7wFf4BHfuQp9KJS?cluster=devnet) `Crp8ZE8CbRYLsMmAya1uiD5atdKZt4b8mAsKGWuQxQTy` with fresh markets. The bots quoted the exact ladder again within 20.8 s and 23.0 s.

| Check | Result | Tx |
|---|---|---|
| Property 1 resolves YES | Oracle path 1, evidence v2 `8aa1d755b774b96561b5da8a89bb8d81d4634740a380f1d28b8237a0adee29aa` = on-chain `evidence_hash`, version 2, round = round 1 | [resolve](https://explorer.solana.com/tx/5JhdgHJk6VZ9RrChA66t3hnibEW3dReu3FrSv5reH9vk48Fpk4zCau8SYumwJHshpm9qrY8YMatxXA83x9NNarY7?cluster=devnet) |
| Property 2 resolves NO | Oracle path 1, evidence v2 `038a7235599dcdd7bb3e54cd7a235d3c4f02d8e6c136545c510f4fe89590586f` = on-chain | [resolve](https://explorer.solana.com/tx/3Zz9ADQZK6qwbt8iMNPX2LN4jVaSCRpgwteLGzP43sFX5KRiVDdtvyiGQU9Jvz1VNr8bAsTD4Wzsn9tJ84vrLPxM?cluster=devnet) |
| Trade on the closed round | Simulated `split` rejected: `RoundNotOpen` ("Trading has closed for this round.") | n/a (simulation) |
| Redeem YES, property 1 | 200 YES → exactly 200,000,000 base units; YES balance 0 | [36VSbCUS…](https://explorer.solana.com/tx/36VSbCUSUjXH4cpUSX8kCjaWYadhhkn3uZBK7y8kfvK7wsZ9ZYsaCagdmWn1NfxDUdrsd7oThSYMZbvpumC8gWxL?cluster=devnet) |
| Redeem NO, property 2 | 50 NO → exactly 50,000,000 base units; NO balance 0 | [2qFTEVVM…](https://explorer.solana.com/tx/2qFTEVVMZEmomQwex7DCjWVyjRrCrj7nWhZnMeeCV47XXB4JawThBdcsjtiw97XKzcgCqEDsW57KZDkyjCK9brnb?cluster=devnet) |

## Worker logs

- **Bots:** 2 failed cancels, both at the close (a race with the sweep), and 2 ticks lost to HTTP 429.
- **Keeper:** 2 ticks lost to HTTP 429. No failed match or sweep.

## Risks for V5 and V6

- **RPC rate limits.** The private Devnet RPC returned HTTP 429 about 350 times across the bots and keeper. Quotes still arrived, but more slowly: 14–23 s against 5.7 s locally. Before the rehearsal, raise `BOTS_POLL_MS` and the keeper interval, or use a higher RPC tier, so the §12 "bots quote within 10 s" check holds on Devnet.
- **Not covered here.** The Phantom browser flow is Gate V6 and needs the V5 app.
