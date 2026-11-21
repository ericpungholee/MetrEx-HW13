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
    const preview = c.previewTrade(book, { outcome: Outcome.Yes, side: OrderSide.Buy, kind: "market", quantity: 300n, slippageBps: 200 }, wallet.toBase58(), plenty);
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
    const preview = c.previewTrade(book, { outcome: Outcome.Yes, side: OrderSide.Buy, kind: "market", quantity: 10n, slippageBps: 200 }, wallet.toBase58(), plenty);
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
