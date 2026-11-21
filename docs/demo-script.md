# MetrEx Devnet verification record

## Core deployment

| Artifact | Confirmed link |
|---|---|
| Deployer funding | [5 Devnet SOL](https://explorer.solana.com/tx/2oacvmsGRg29T1vi68VbEBCaM7pN3LXy4Tba9x2gxcRvPCP1b7o9jYkYVSCPyBuyXgTKGqGrkFF2137eqPityJ85?cluster=devnet) |
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
- The 10,000 mUSD claim is pending. Before the claim, the homeowner held 24,600 mUSD and 0.048478560 Devnet SOL.
