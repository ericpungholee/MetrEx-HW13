import { findOfferPda, type MarketAccount, type OfferAccount } from "@metrex/shared";
import { Keypair } from "@solana/web3.js";
import { expect, it } from "vitest";
import { computePortfolio } from "./derive";
import { getFixtureState } from "./fixtures";
import type { Keyed } from "./types";

it("tracks current holdings through sale, resale, repurchase and refund", async () => {
  const program = Keypair.generate().publicKey;
  const fixture = await getFixtureState(program);
  const market: Keyed<MarketAccount> = { ...fixture.markets[0]!,
    account: { ...fixture.markets[0]!.account, status: { open: {} } },
  };
  const original = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;
  const reseller = Keypair.generate().publicKey;
  const offer: Keyed<OfferAccount> = {
    publicKey: findOfferPda(program, market.publicKey, original, 1n)[0],
    account: {
      ...fixture.offers[0]!.account, market: market.publicKey,
      underwriter: original, riskHolder: original, protectionHolder: market.account.homeowner,
      status: { accepted: {} },
    },
  };
  const coverage = BigInt(offer.account.coverage.toString());
  const premium = BigInt(offer.account.premium.toString());
  const view = (wallet: typeof original) => computePortfolio(wallet, [market], [offer]);
  expect(view(original).totalExposure).toBe(coverage);

  for (const newHolder of [buyer, reseller, original]) {
    const prev = offer.account.riskHolder;
    offer.account.riskHolder = newHolder;
    expect(view(prev).totalExposure).toBe(0n);
    expect(view(newHolder).totalExposure).toBe(coverage);
    expect(view(original).premiumsBooked).toBe(premium);
    expect(view(newHolder)).not.toHaveProperty("realizedPnl");
  }

  market.account.status = { voided: {} };
  offer.account.status = { refunded: {} };
  expect(view(original).positions[0]?.status).toBe("refunded");
  expect(view(original).totalExposure).toBe(0n);
  expect(view(original).premiumsBooked).toBe(premium);
  expect(view(market.account.homeowner).premiumsPaid).toBe(premium);
});
