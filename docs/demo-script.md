# MetrEx Devnet verification record

## Core deployment

| Artifact | Confirmed link |
|---|---|
| Deployer funding | [5 Devnet SOL](https://explorer.solana.com/tx/2oacvmsGRg29T1vi68VbEBCaM7pN3LXy4Tba9x2gxcRvPCP1b7o9jYkYVSCPyBuyXgTKGqGrkFF2137eqPityJ85?cluster=devnet) |
| Tier 2 upgrade funding | [5 Devnet SOL](https://explorer.solana.com/tx/9R4HqDU2FfRYjcMKWSqNDzzNWJVoU2QRwmkpUC6dP2yHtXLm93aDy6K7JEZfKfJx71aB2wb6Rakj3yqEWksKREi?cluster=devnet) |
| Program | [Program account](https://explorer.solana.com/address/AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X?cluster=devnet) · [deployment](https://explorer.solana.com/tx/hMFk5fMLHeLoCs1Gnumto21MyAyoqUeQ5PCBkArNZuwdtnbNDTCdMyDwQtdrm4mVTjQjEqeigJFvdJ2V3Ak8aRC?cluster=devnet) |
| ProgramData | [Data and upgrade authority](https://explorer.solana.com/address/7WP4fbCZFST5sipMWH88GR3tFZPwzc3N3NBXvyUBqw8h?cluster=devnet) |
| Config | [Config PDA](https://explorer.solana.com/address/EviMmkJeJAb6qgXpc2dYkyB9PTqqinETDojsx4zWM2wU?cluster=devnet) · [initialize](https://explorer.solana.com/tx/2kGxQxP5GUexaBZeN3QE7AQL36cmsos3oUfo2EZR9j98sZ8JpLFJCpT39284FZT5iYcJyndqbixq4E2pxKouRJDf?cluster=devnet) |
| mUSD | [Classic SPL mint](https://explorer.solana.com/address/6cb8kKLX9hSfAeLGYxutmbadSckUfZ5cD8KyYZGNbTQC?cluster=devnet) |
| Property 1 | [Home #1042](https://explorer.solana.com/address/CbZm7hcvqKnoPDaNM64BZJMukWDjRZ4BFZYf8FD7Mgjs?cluster=devnet) |
| Property 2 | [Home #2210](https://explorer.solana.com/address/777mfFeqkfbyNXzakuh7E4NHti1z1suCqKyw1vVNSHvg?cluster=devnet) |
| Property 3 | [Home #1187](https://explorer.solana.com/address/46MbRBiqw66Xxs76KdfdrXvUnGfwU4N4kZphncp19pRX?cluster=devnet) |
| Demo funding | [SOL batch 1](https://explorer.solana.com/tx/3nnK5VEQXLade1MiSwjWLXQxiYnPvz4bNgRdUKFiG4hVwHmSoKqV6isYxHhTn42hwiToMxGpudPZgfVyfU9Up9Ph?cluster=devnet) · [SOL batch 2](https://explorer.solana.com/tx/bG2V1c6bEepSSzFPs8FKyacVM9c7kqvS6SpJfF4bp9nPdgbCb5vcCpQJ9CZ2vAKFxpJ4DuwJHsCD4L34SuXamGn?cluster=devnet) · [mUSD batch 1](https://explorer.solana.com/tx/hjjsqvwwx1TALKiTG46ChBS2GVgDoD2ZppcXPM4rzFd3yWaKMKSghhqGd4Yea1XatCwe21kNkvNEPAW4HzzUF6E?cluster=devnet) · [mUSD batch 2](https://explorer.solana.com/tx/86A9kZX98mg2PZ7kzjdY2kqCTygqmda3teM6SQWRn9jATd5FfUUftuVgPo9CZah8DxyujVMURD96wWZeK98NMRF?cluster=devnet) |
| Funded fallback | [Market with 10,000 mUSD activated](https://explorer.solana.com/address/SVZRpB86HB4Yb3FnPyk7LocQt8MgVu7ajov9mSmCYmi?cluster=devnet) · [Batch acceptance of three offers](https://explorer.solana.com/tx/4YW9ybBDyvkc3cYC3AvDmyHvbdmdmzeQywgarCnUE1GyX2tFd7xWnk6xFqfTWzme2fADNamWxHMPXt5Xa7aaCCgw?cluster=devnet) |

The on-chain ELF bytes matched the local core build. Upgrade authority is the admin `sQuXrM2LYdxq5sc8dAcsfgFSoa9V6jfNk5txzea87sD`. Use the fallback market only if the live replay stalls before acceptance.

## Core wallet check

Run the app with fixtures off and trading disabled. Create Home #1042 at 10,000 mUSD. Place one collateralized offer from a separate judge wallet. Accept from the homeowner wallet, close and resolve on the operator side, then have the homeowner claim 10,000 mUSD. The scripted equivalent is `pnpm tsx scripts/prove-lifecycle.ts --manual`.

### Scripted wallet-equivalent run on Devnet

- [Home #1042 market](https://explorer.solana.com/address/AnWuzR6A9TLYNR7YFJHCnm6Js5reaa192fGRgDyzvoWB?cluster=devnet)
- [Create](https://explorer.solana.com/tx/5sZvv8SzpRqfTLxb83pKrSREmSHUcBSm7u2J4QdSdsZvcECxyEm4n4kEuhLNnkVBCnA3AjPBmkzjmmSAWX7neUbt?cluster=devnet) · [Judge offer](https://explorer.solana.com/tx/GxaxGQ4VK78WcoayaZmFLxxDVsPdhUmbY5fzLMNrnqQBdbvfcJ82acg5dvDZREDQda6t7DEyVumK5DnMPZfsa48?cluster=devnet) · [Accept](https://explorer.solana.com/tx/48qwLdKgdNbWhtRHKFUrvdwJj76LeAKXUga5SuvzSBJ6ZLaorC789dcV4ejTsooftGqRsA4dFZFdMsDjhzRxioiu?cluster=devnet)
- [Close](https://explorer.solana.com/tx/3EtaS2HzJMEzgirEWxdijL2LdJGRHNmt2Am5affnnvXT9CUhLHKFoPTiPegyNuhheM4RaKD6YeSikbgi2hsw4UMY?cluster=devnet) · [Resolve](https://explorer.solana.com/tx/548aHuc3mvYQdc39AuYKmt4jbFW9ndXaje3WMJzuz7RNqNReXwU5mw37jDrdwpzME9KcYKmYXkCzj6o2HUTUG6rq?cluster=devnet) · [10,000 mUSD claim](https://explorer.solana.com/tx/2bXvpNZbvSa45HgUd8SwD38HtE1C58UTBCN49Y1AeRrJ9rcZrnLKjCPnPssYsYmdz3KcLTkjgPFzERYvHF98UXHG?cluster=devnet)
- [Canonical evidence](../data/evidence/AnWuzR6A9TLYNR7YFJHCnm6Js5reaa192fGRgDyzvoWB.json), SHA-256 `85293fc63739a4fc8425b0ba276d6de4bc90ccd90eabd38528b6690a5fd515c7`.

### Phantom wallet run on Devnet

- [Home #1042 market](https://explorer.solana.com/address/GSychaNiCkwZuexBzdDEoHxqaESvpvUS4P3G8Z4a8GXk?cluster=devnet) · [local market page](http://127.0.0.1:3014/market/GSychaNiCkwZuexBzdDEoHxqaESvpvUS4P3G8Z4a8GXk)
- [Phantom create](https://explorer.solana.com/tx/5EVQsqginMf8YkyYAmoyUmTb9ZRyScQ1xgu9gU6UaV5d5XKBxGsvmhAJy1kSxGDFYLmh1J2gp53fMtsoPTHHNWvd?cluster=devnet) · [Judge offer](https://explorer.solana.com/tx/3vvpjAJFbFvB1drTntqbf5HtnwufsuYZEMSAJ3FpNNHStZeWybN8q6U5zGZFvZFts7GdL7Jc3G36YBoxzT7XcEcj?cluster=devnet) · [Phantom accept](https://explorer.solana.com/tx/2ahPRpk82SXYqcaiwSrRTh2FuuQT8bHdGHVijd4YuxjkkT2MLm3UcnRS1E9zZ58wmtGkRDdBQWrwuh4vm6RDBVei?cluster=devnet)
- [Operator close](https://explorer.solana.com/tx/3aSuWfLSdk8SaXh6XpD12QoLSoFrKXh99vdBcbtyNxHthCCoFzyZMU1WdW5vD15FjMw1odfoxQU2pCVNV3nUr5eY?cluster=devnet) · [YES resolution](https://explorer.solana.com/tx/hn8oPZ3yAL68Yki4nbxfNSrn238ByCJR9pzBQmVBjDnio7kvw17wp95jaZP8HPrcjM5DYuUg5pJmgX1bRJh7LUq?cluster=devnet)
- [Canonical evidence](../data/evidence/GSychaNiCkwZuexBzdDEoHxqaESvpvUS4P3G8Z4a8GXk.json), SHA-256 `66b8d245db449a9e40e76e33b749b33ed1a1c481fcc427ade2754476ba192288`.
- [Phantom claim](https://explorer.solana.com/tx/5NhpBhU26ZVQcf8kAtDCfHGzgmqEGDXBtQoa7JDAohZioJxYZoXAvSbi13UHbafPx4j8VrBVH8poMqSz5k8KUunD?cluster=devnet) closed the vault and increased the homeowner balance from 24,600 to 34,600 mUSD. The fee was 0.00008 Devnet SOL and the wallet's remaining balance was 0.048398560 SOL.

### Bot and oracle verification on Devnet

- [Fresh-wallet faucet transaction](https://explorer.solana.com/tx/31a6qKS6Rwqh3V9gnX9kcMSJWT7ViuTuGiZrRxUds9s1251rAs59ooPjyvMvWRr2ogsGTuP2g1Yzow41AJdp4QAL?cluster=devnet) sent 25,000 mUSD and 0.05 SOL.
- YES [market](https://explorer.solana.com/address/4fntZJ6eujspKqtJ1VcCvoEocQFzJBrkH2P4Ht5CjaeD?cluster=devnet) · [create](https://explorer.solana.com/tx/2VPDeDoccUEKw38TuYeiyZrWvp4h1NVJUmdV3VurrZpqiu7VQ5avLHZfDncidxE78c5oom4Ptkq3bPXzizsgUxoz?cluster=devnet) · [batch accept](https://explorer.solana.com/tx/5WYJzW5yH4Afsi6QnPcT5sRyuZvqXsRp6g1pJEmLc1Bn8bhsUa8TeZwT8a7bZjTmkPi9Hp53oiPmNYELuc9WWEU4?cluster=devnet) · [close](https://explorer.solana.com/tx/2otH8uT3pjNUuno4pk3HTDcLNEHX3dddhhZeMygt89dNZfQaiU4mcFjvPbj2o98MKp3oi1PucMNXei5pKxt5Bqbe?cluster=devnet) · [resolve](https://explorer.solana.com/tx/5hakd9whHsnGVvYQiwBARt6p6a6JZeSrpRxXwQ7etnx68CpSbo6dBVNsYk37S63VTE2ETFe3CGAjDvYSMcNKToGN?cluster=devnet) · [single homeowner claim](https://explorer.solana.com/tx/4CHhjx2La8kLj8LuNsvt3uoV1rGSAduV9dYaLFKtdYLdpj3obWR4h8aiQWgWq6QdbPD4hdxmgrgLpDyqCrKnaAfn?cluster=devnet). Three bot offers arrived in 4.332 s. The homeowner received 10,000 mUSD. [Evidence](../data/evidence/4fntZJ6eujspKqtJ1VcCvoEocQFzJBrkH2P4Ht5CjaeD.json) matched SHA-256 `c1a0fae8b314d35572a6222989bc83d92e8be741794f2a2cd247cd496d537274`.
- NO [market](https://explorer.solana.com/address/YAzVbzkXkG6vBFSxvPdDDQTtmhQJu1fztAGrAwNKsU2?cluster=devnet) · [create](https://explorer.solana.com/tx/4UQP19bUbvYcZ1r8AGLrwY5BY6mL5HxBgdU1SZrjSSbRbCr9Gis2XCs6NCkm3yBtpJx5vWfYh1J4JwoskiYehDH5?cluster=devnet) · [batch accept](https://explorer.solana.com/tx/2qj4AhxJwrMYre3pBHBRSx3eGjEs48wN3KpPdW7n79XtS54GZE2eoL9dZDGgbmkZwYqk6Hq4sK9ErTLkT8qPTPD7?cluster=devnet) · [close](https://explorer.solana.com/tx/4XN42S2AXWLwf4XaBKVzgRxQL3BMzHKFPboF6Sso3MAAMZMb4e491DQKvwwARaqjQNNwptBkMD5EfcU7WeDXWvXa?cluster=devnet) · [resolve](https://explorer.solana.com/tx/28tDJU6jvjCP3q4V4cz6osdT7uFVZx4q2BBvy42BRfH7Z7HkGhXENwn9hQqsY3SZxr8iz4XhPMrRd9o5tFawGmoP?cluster=devnet) · [Bot A claim](https://explorer.solana.com/tx/5LU1tEEVEEgwVSNzy8oXNfFroPLUUzT18qAFoPDDUMPApNGDTgq9YPDwyQkCvp6dbCYdyX2rH25Zreizei9joGLF?cluster=devnet) · [Bot B claim](https://explorer.solana.com/tx/4muWGPKUm5ERZdZsG2KmD6qDvQHxnvjVJSg5z6QgcNsyHfLMENUF3GAg4VYexz9AoKvzK5vC2J8ecKDW1Yv8cStg?cluster=devnet) · [Bot C claim](https://explorer.solana.com/tx/2QvsVPFxixD4NEhX9F2q6iHDYVvvm8KJ9Y7Vic7CsgPhTf14GKUTGGzxSoBPaea9obVfrZaVsdwz4iXHCSZWkF4X?cluster=devnet). Three bot offers arrived in 9.217 s. The three underwriters received 10,000 mUSD in total. [Evidence](../data/evidence/YAzVbzkXkG6vBFSxvPdDDQTtmhQJu1fztAGrAwNKsU2.json) matched SHA-256 `449524a1498b8622d02fec2dcaa2a13d9abfcfcb6c71ae29325895575833b472`.

### Trading verification on Devnet

- [Program upgrade](https://explorer.solana.com/tx/2R5AiZXniXw3cjTDxWfwv53P1DRBzdg7DxEdYX6tu7nTxJsBdwveSpf5coWqsXE3EdKSbCywKH4xWMykhQPqEFCH?cluster=devnet) finalized at slot 524619550. ProgramData still reports the admin as upgrade authority. The 555,992-byte ELF matched SHA-256 `c16de82a1c256c3a3e9df61773f1d8b71f985887facf1300f51baa01bbb5af9e`.
- [Trading market](https://explorer.solana.com/address/GXJMczUXHYm71Nedv3ZmFWCFEc5ZyzQRsyhQbaJjnxrF?cluster=devnet) · [390 bps judge offer](https://explorer.solana.com/tx/5cKU5KrJyQ74JAAtrvtHhMUanCp1J3aGse4hibtqbqbfX2zpnxU2SUXCAGEhqSX18uc1uzgDzczLJgHWM9PXwfac?cluster=devnet) · [380 bps](https://explorer.solana.com/tx/2SWhnRJ12sj99GG1HjoEDbdHHYJe1XrXou4T348HiJWbBpiZ365CDkUj11uNpB9NQVL3xWwPJxB2o3494mNYuuTi?cluster=devnet) · [400 bps](https://explorer.solana.com/tx/3E3MJ3A7TfFcMRL2BimejsidppVthTMSHA2C7E1HfszS4WzHjKkVTNr3MM8MLHQwPv4dVB3o2nvWV7nd5mLUBLnF?cluster=devnet) · [450 bps](https://explorer.solana.com/tx/23UvRYiJdczUBd77MqzZ66wNhbu1zxNurzuvowxsGgndSJp4jw8ndid6igjTqgqSKLZDTYgEesFYx6wMC8j1cE1x?cluster=devnet) · [batch accept](https://explorer.solana.com/tx/k8PwGhXGfSLg3BCDRtddZr6cJDPiF7HMfp1QSrqChi2K6Zf2hD5e9N3boNSaVaymSmgTq94q2FQqmVCqJ6h8qQN?cluster=devnet).
- [Risk listing](https://explorer.solana.com/tx/3dSvkNpAM4jzt4QLQG7EzQjZLoJexwSrkyCT2kG2ceLKnRF9kToWnCsNfLspVNm5wzqGm6CfXxwfqG155c9UNqVw?cluster=devnet) · [judge purchase for 2,932.50 mUSD](https://explorer.solana.com/tx/vgmY4svy9Dh28ex2fFGBaQjUa6UHNujfXEzNHsN6fGsB9o7KoRLT2D5AA2SCft23FpBh7nudzsDXPnyd9gWfMzi?cluster=devnet) · [NO resolution](https://explorer.solana.com/tx/4cTnyALHsa25kQK88wk4BWEASzrKikdbpkTfAnSUiWXGRZDNe6V9TLpZLXavsv479Z4dqSVS6oorTFcgV1hjZhkH?cluster=devnet) · [new Risk holder claims 3,000 mUSD](https://explorer.solana.com/tx/2MpeYqaXG4RMruznNSVsxzYwERCzhvrdKyzJES38kz8FbFPVjAb9A3cxnevkckA52uUJe7HTNjNrS3Z44NqVdLFL?cluster=devnet). The combined settlement paid 10,000 mUSD.
- [Canonical evidence](../data/evidence/GXJMczUXHYm71Nedv3ZmFWCFEc5ZyzQRsyhQbaJjnxrF.json), SHA-256 `21cb6bd1cefd065a07a472142196408672926c4dc838521378e63f7acbe104c9`.
- [Demo-day top-up](https://explorer.solana.com/tx/4AeXEUUNkx4AHPrSwTASoBXFmNZzs2zzZyJfrKR6medFnQyftd5APkWB3YnrsYefARmSxXh11gdyBi135MnmY2vb?cluster=devnet) brought all three bots to 1.01 SOL. Their mUSD balances were 242,632, 244,525 and 244,517.50.
- [Faucet top-up](https://explorer.solana.com/tx/4cqhWh6sE1Are4FVihWmhDCte8737gwuzQmMcP8eyPCM61LUkbezCKkjPff2411JvMURf4u68z6YRwaCN7qS2fNt?cluster=devnet) brought the demo faucet to 5.693713800 Devnet SOL.

## Demo rehearsal

### Start the demo on the configured Mac

Run the bridge, app and bot worker from the repository root in three terminals. Configure the operator password separately and mount the normalized geometry and scenario registry in a writable private oracle data directory. Set `METREX_ORACLE_DATA_DIR` for the production app. Enable the operator controls on Devnet once the integrity program build is deployed.

```sh
node ~/.config/metrex/devnet-bridge.cjs
pnpm --filter app build
METREX_ORACLE_DATA_DIR="$HOME/.config/metrex/oracle-data" pnpm --filter app start --hostname 127.0.0.1 --port 3014
node --env-file=.env --import tsx services/bots/src/index.ts
```

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
4. On the settlement page, show the 500 m trigger circle and close the market. Wait for finalized closure, run the oracle, then show the final perimeter and the browser's evidence hash check.
5. Claim all three YES positions in one transaction. Show the 10,000 mUSD balance increase and link to the claim.
6. For the secondary market, switch to Home #2210. Show the 3.9% judge offer, the requotes and the network panel. Buy a listed Risk position with a judge wallet while trading is open. Close and resolve the market, then show the new holder claiming.

## Verification and recording

- Stop the bot worker for the manual wallet check. Use a separate judge wallet to place the offer and the homeowner wallet to create, accept and claim. Run `pnpm tsx scripts/prove-lifecycle.ts --manual` for the app-client check with the demo keys.
- Start the bot worker and run `pnpm tsx scripts/prove-lifecycle.ts` for the two core outcomes. Run `pnpm tsx scripts/prove-lifecycle.ts --tier2` once the program supports trading and the Tier 2 worker is running.
- Record the app and wallet confirmations as they happen. Use a public view for the operator panel and hide local key paths and the demo password during recording.
- Rehearse the fallback tab. If a live bot round stalls, open the already funded fallback and continue at settlement. Keep the completed YES and NO recordings available if the RPC becomes unreliable.
- The November 21 recording is a 34-second browser replay of the finalized Phantom payout, three-position settlement, evidence verification and Risk purchase and claim. The video is stored locally as `metrex-devnet-demo.webm`.
