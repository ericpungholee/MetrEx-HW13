// Gate V5 / workstream C acceptance (build-plan-v2): a market buy and a limit order each build one
// transaction, and a simulated RoundNotOpen is shown in plain words. Runs against the fixture book
// (NEXT_PUBLIC_USE_FIXTURES=1 is stubbed before the client module loads); no RPC is reached.
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ERROR_CODE_OFFSET, ERROR_NAMES, OrderSide, Outcome } from "@metrex/exchange";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { measureTransactionSize, MAX_TX_BYTES } from "./batch";
import { FIXTURE_KEYS } from "./exchange-fixtures";

type Client = typeof import("./exchange-client");
let c: Client;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_USE_FIXTURES", "1");
  vi.resetModules();
  c = await import("./exchange-client");
});
afterAll(() => vi.unstubAllEnvs());

const wallet = Keypair.generate().publicKey;
const plenty = { musd: 10n ** 12n, shares: 10n ** 9n };

async function fixtureMarket() {
  const info = await c.fetchMarketInfo(FIXTURE_KEYS.market1);
  if (!info) throw new Error("fixture market missing");
  const book = c.bookOrders(await c.fetchBook(FIXTURE_KEYS.market1));
  return { market: info.market, book };
}

const programId = () => c.EXCHANGE_PROGRAM_ID.toBase58();
const exchangeIxNames = (ixs: { programId: PublicKey; data: Buffer }[]) => {
  const coder = c.exchangeProgram().coder.instruction as unknown as { decode(data: Buffer): { name: string } | null };
  return ixs.filter((ix) => ix.programId.toBase58() === programId()).map((ix) => coder.decode(ix.data)?.name);
};

describe("trade building (one transaction each)", () => {
  it("market buy: takes the best asks in a single transaction within the size limit", async () => {
    const { market, book } = await fixtureMarket();
    const preview = c.previewTrade(book, { outcome: Outcome.Yes, side: OrderSide.Buy, kind: "market", quantity: 300n, slippageBps: 5000 }, wallet.toBase58(), plenty);
    expect(preview.problems).toEqual([]);
    expect(preview.fills.length).toBeGreaterThan(1); // crosses more than one level
    const { ixs } = await c.buildTrade(wallet, market, book, preview);
    expect(exchangeIxNames(ixs)).toEqual(preview.fills.map(() => "takeOrder"));
    expect(measureTransactionSize(ixs, wallet, PublicKey.default.toBase58())).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it("crossing limit order: place_order plus match_orders in a single transaction", async () => {
    const { market, book } = await fixtureMarket();
    const preview = c.previewTrade(book, { outcome: Outcome.Yes, side: OrderSide.Buy, kind: "limit", quantity: 250n, priceBps: 500, slippageBps: 0 }, wallet.toBase58(), plenty);
    expect(preview.problems).toEqual([]);
    const built = await c.buildTrade(wallet, market, book, preview);
    const names = exchangeIxNames(built.ixs);
    expect(names[0]).toBe("placeOrder");
    expect(names.slice(1).every((n) => n === "matchOrders")).toBe(true);
    expect(names.length).toBe(1 + built.preview.fills.length);
    expect(measureTransactionSize(built.ixs, wallet, PublicKey.default.toBase58())).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it("resting limit order: one place_order, no matches", async () => {
    const { market, book } = await fixtureMarket();
    const preview = c.previewTrade(book, { outcome: Outcome.Yes, side: OrderSide.Buy, kind: "limit", quantity: 10n, priceBps: 300, slippageBps: 0 }, wallet.toBase58(), plenty);
    const { ixs } = await c.buildTrade(wallet, market, book, preview);
    expect(exchangeIxNames(ixs)).toEqual(["placeOrder"]);
  });
});

describe("simulation failures in plain words", () => {
  it("RoundNotOpen", async () => {
    const code = ERROR_CODE_OFFSET + ERROR_NAMES.indexOf("RoundNotOpen");
    const conn = c.exchangeConnection();
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 });
    const sim = vi.spyOn(conn, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: {
        err: { InstructionError: [0, { Custom: code }] },
        logs: [`Program log: AnchorError occurred. Error Code: RoundNotOpen. Error Number: ${code}. Error Message: round not open.`],
        accounts: null,
        unitsConsumed: 0,
        returnData: null,
      },
    });
    const { market, book } = await fixtureMarket();
    const preview = c.previewTrade(book, { outcome: Outcome.Yes, side: OrderSide.Buy, kind: "market", quantity: 10n, slippageBps: 5000 }, wallet.toBase58(), plenty);
    const { ixs } = await c.buildTrade(wallet, market, book, preview);
    const err = await c.simulate(ixs, wallet).catch((e: unknown) => e);
    expect(sim).toHaveBeenCalledWith(expect.any(VersionedTransaction), expect.objectContaining({ sigVerify: false }));
    expect(err).toBeInstanceOf(c.ExchangeTxError);
    expect((err as Error).message).toBe("Trading has closed for this round.");
    expect((err as Error).message).not.toMatch(/0x|Error Code|custom program error|\d{4}/);
  });
});

describe("price text", () => {
  it("round-trips cents per share and basis points", async () => {
    const f = await import("./exchange-format");
    expect(f.formatPrice(430)).toBe("4.30¢");
    expect(f.formatPrice(80)).toBe("0.80¢");
    expect(f.formatPrice(1)).toBe("0.01¢");
    expect(f.formatPrice(9_999)).toBe("99.99¢");
    expect(f.formatPrice(415.5)).toBe("4.155¢");
    expect(f.parsePriceToBps("4.30")).toBe(430);
    expect(f.parsePriceToBps("0.8")).toBe(80);
    expect(f.parsePriceToBps("0.80¢")).toBe(80);
    expect(f.parsePriceToBps("50")).toBe(5000);
    expect(f.parsePriceToBps(".01")).toBe(1);
    expect(f.parsePriceToBps("0")).toBeNull();
    expect(f.parsePriceToBps("100")).toBeNull();
    expect(f.parsePriceToBps("0.001")).toBeNull();
  });
});

describe("coverage execution integrity", () => {
  it("keeps fractional-cent slippage relative and caps the sum of signed prices", async () => {
    const { market } = await fixtureMarket();
    const orders = [25, 27, 30].map((priceBps, i) => ({
      id: Keypair.generate().publicKey.toBase58(), maker: Keypair.generate().publicKey.toBase58(),
      outcome: Outcome.Yes, side: OrderSide.Sell, priceBps, remaining: 50_000n, seq: BigInt(i + 1),
    }));
    const ticket = { outcome: Outcome.Yes, side: OrderSide.Buy, kind: "market", quantity: 125_000n, slippageBps: 1_000 } as const;
    const preview = c.previewTrade(orders, ticket, wallet.toBase58(), plenty);
    expect(preview.limitPriceBps).toBe(27);
    expect(preview.maxSpend).toBe(260_000_000n);
    expect(preview.filledQty).toBe(100_000n);
    expect(preview.restQty).toBe(25_000n);
    expect(c.previewTrade(orders, ticket, wallet.toBase58(), { shares: 0n, musd: preview.maxSpend - 1n }).problems).toContain("Not enough mUSD in your wallet.");
    const built = await c.buildTrade(wallet, market, orders, preview);
    expect(exchangeIxNames(built.ixs)).toEqual(["takeOrder", "takeOrder"]);
    expect(built.ixs.filter((ix) => ix.programId.equals(c.EXCHANGE_PROGRAM_ID)).map((ix) => ix.data.readUInt16LE(16))).toEqual([25, 27]);
    const changed = orders.map((o, i) => i === 0 ? { ...o, priceBps: 26 } : o);
    await expect(c.buildTrade(wallet, market, changed, preview)).rejects.toThrow(/book changed/i);
  });

  it("packs oversized claims into sweeps and rebuilds redemption from the resulting balances", async () => {
    const { market } = await fixtureMarket();
    const resolved = { ...market, outcome: "invalid" } as const;
    const orders = Array.from({ length: 12 }, (_, i): import("./exchange-client").WalletOrder => ({
      address: Keypair.generate().publicKey.toBase58(), market: market.address, maker: wallet.toBase58(),
      clientNonce: BigInt(i), outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 50,
      originalQty: 1n, remainingQty: 1n, seq: BigInt(i), expiresAt: 0n, createdAt: 1n,
      tradingOpen: false, marketOutcome: "invalid",
    }));
    const plan = await c.buildRedeem(wallet, resolved, orders, { yes: 2n, no: 1n });
    expect(plan.readAfterSweeps).toBe(true);
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches.flatMap(exchangeIxNames)).toEqual(Array(12).fill("sweepOrder"));
    for (const instructions of plan.batches) {
      expect(measureTransactionSize(instructions, wallet, PublicKey.default.toBase58())).toBeLessThanOrEqual(MAX_TX_BYTES);
    }
    const final = await c.buildRedeem(wallet, resolved, [], { yes: 14n, no: 1n });
    expect(final.batches.flatMap(exchangeIxNames)).toEqual(["redeem", "redeem"]);
    expect(c.redemptionValue("invalid", 14n, 1n)).toBe(7_500_000n);
    const done = await c.buildRedeem(wallet, resolved, [], { yes: 0n, no: 0n });
    expect(done.batches).toEqual([]);
  });
});
