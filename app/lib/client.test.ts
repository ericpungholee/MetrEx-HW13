import { Keypair, type VersionedTransactionResponse } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
import idl from "../../target/idl/metrex.json";
import { getFixtureState } from "./fixtures";
import { acceptOffers, createMarket, fetchActivity, fetchEvidenceText, fetchNetworkStats, getConnection, getProgram, IDL, PartialBatchError, type WalletSigner } from "./client";

afterEach(() => vi.restoreAllMocks());

it("submits browser transactions with the app connection for wallet chain selection", async () => {
  const conn = getConnection();
  const blockhash = Keypair.generate().publicKey.toBase58();
  vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash, lastValidBlockHeight: 100 });
  const confirm = vi.spyOn(conn, "confirmTransaction").mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
  const sendRaw = vi.spyOn(conn, "sendRawTransaction");
  const wallet: Required<WalletSigner> = {
    publicKey: Keypair.generate().publicKey,
    sendTransaction: vi.fn().mockResolvedValue("wallet-signature"),
    signTransaction: vi.fn(),
    signAllTransactions: vi.fn(),
  };

  const { results } = await createMarket(wallet, 1, 10_000_000_000n);

  expect(wallet.sendTransaction).toHaveBeenCalledWith(
    expect.objectContaining({ feePayer: wallet.publicKey, recentBlockhash: blockhash }),
    conn,
    { preflightCommitment: "confirmed" },
  );
  expect(wallet.signTransaction).not.toHaveBeenCalled();
  expect(sendRaw).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith({ signature: "wallet-signature", blockhash, lastValidBlockHeight: 100 }, "confirmed");
  expect(results[0]?.signature).toBe("wallet-signature");
});

it("keeps Explorer links tied to their events when the RPC batch comes back in reverse order", async () => {
  const conn = getConnection();
  const market = Keypair.generate().publicKey;
  const discriminator = idl.events.find((item) => item.name === "MarketClosed")!.discriminator;
  const logData = Buffer.concat([Buffer.from(discriminator), market.toBuffer(), Buffer.alloc(8)]).toString("base64");
  const logs = [`Program ${IDL.address} invoke [1]`, `Program data: ${logData}`, `Program ${IDL.address} success`];
  vi.spyOn(conn, "getSignaturesForAddress").mockResolvedValue([
    { signature: "close-b", slot: 2, err: null, memo: null },
    { signature: "close-a", slot: 1, err: null, memo: null },
  ]);
  function record(signature: string, slot: number): VersionedTransactionResponse {
    return { transaction: { signatures: [signature] }, meta: { logMessages: logs }, slot } as VersionedTransactionResponse;
  }
  vi.spyOn(conn, "getTransactions").mockResolvedValue([record("close-a", 1), record("close-b", 2)]);

  const activity = await fetchActivity(market);

  expect(activity.map(({ name, signature, slot }) => ({ name, signature, slot }))).toEqual([
    { name: "MarketClosed", signature: "close-b", slot: 2 },
    { name: "MarketClosed", signature: "close-a", slot: 1 },
  ]);
});

it("shows only the current market's events in a transaction shared by two markets", async () => {
  const conn = getConnection();
  const firstMarket = Keypair.generate().publicKey;
  const secondMarket = Keypair.generate().publicKey;
  const firstOffer = Keypair.generate().publicKey;
  const secondOffer = Keypair.generate().publicKey;
  const signer = Keypair.generate().publicKey;
  const listing = Keypair.generate().publicKey;
  function event(name: string, ...fields: Buffer[]) {
    const discriminator = idl.events.find((item) => item.name === name)!.discriminator;
    return `Program data: ${Buffer.concat([Buffer.from(discriminator), ...fields]).toString("base64")}`;
  }
  const logs = [
    `Program ${IDL.address} invoke [1]`,
    event("PayoutClaimed", firstMarket.toBuffer(), firstOffer.toBuffer(), signer.toBuffer(), Buffer.alloc(8)),
    event("PayoutClaimed", secondMarket.toBuffer(), secondOffer.toBuffer(), signer.toBuffer(), Buffer.alloc(8)),
    event("PositionListed", firstOffer.toBuffer(), listing.toBuffer(), Buffer.from([1]), signer.toBuffer(), Buffer.alloc(8)),
    `Program ${IDL.address} success`,
  ];
  const signature = "mixed-market-activity";
  vi.spyOn(conn, "getSignaturesForAddress").mockResolvedValue([{ signature, slot: 3, err: null, memo: null }]);
  const getTransactions = vi.spyOn(conn, "getTransactions").mockResolvedValue([
    { transaction: { signatures: [signature] }, meta: { logMessages: logs }, slot: 3 } as VersionedTransactionResponse,
  ]);

  const first = await fetchActivity(firstMarket, 25, new Set([firstOffer.toBase58()]));
  const second = await fetchActivity(secondMarket, 25, new Set([secondOffer.toBase58()]));
  const wallet = await fetchActivity(signer);

  expect(first.map(({ name }) => name)).toEqual(["PayoutClaimed", "PositionListed"]);
  expect(second.map(({ name }) => name)).toEqual(["PayoutClaimed"]);
  expect(second[0]?.data.offer).toEqual(secondOffer);
  expect(wallet).toHaveLength(3);
  expect(getTransactions).toHaveBeenCalledTimes(1);
});

it("requests the exact evidence bytes for the browser hash check", async () => {
  const market = Keypair.generate().publicKey;
  const canonicalEvidence = '{"triggered":true}';
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(canonicalEvidence));

  expect(await fetchEvidenceText(market)).toBe(canonicalEvidence);
  expect(fetch).toHaveBeenCalledWith(`/api/evidence/${market.toBase58()}?raw=1`, { cache: "no-store" });
});

it("reports pending fee lookups and cached status to the network panel", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    txTotal: 65,
    txLast10Min: 25,
    totalFeesLamports: "285000",
    feesPending: 25,
    stale: true,
    truncated: false,
  }));

  expect(await fetchNetworkStats()).toEqual({
    txTotal: 65,
    txLast10Min: 25,
    feesSol: "0.000285",
    feesPending: 25,
    stale: true,
    truncated: false,
  });
});


it("preserves confirmed chunks and resumes with the remaining offers after a wallet rejection", async () => {
  const conn = getConnection();
  const fixtures = await getFixtureState(getProgram().programId);
  const base = fixtures.offers[0]!;
  const offers = Array.from({ length: 30 }, () => ({ ...base, publicKey: Keypair.generate().publicKey }));
  const publicKey = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash, lastValidBlockHeight: 100 });
  vi.spyOn(conn, "getAccountInfo").mockResolvedValue(null);
  vi.spyOn(conn, "confirmTransaction").mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
  vi.spyOn(getProgram().account.config, "fetchNullable").mockResolvedValue(fixtures.config);
  const submit = vi.fn()
    .mockResolvedValueOnce("first")
    .mockRejectedValueOnce(new Error("User rejected the request"))
    .mockResolvedValue("resumed");
  const wallet: Required<WalletSigner> = {
    publicKey, sendTransaction: submit, signTransaction: vi.fn(), signAllTransactions: vi.fn(),
  };

  await expect(acceptOffers(wallet, base.account.market, offers)).rejects.toMatchObject({
    name: PartialBatchError.name, confirmed: [{ signature: "first" }],
  });
  const firstChunk = submit.mock.calls[0]![0].instructions.length - 1; // ATA prefix
  expect(firstChunk).toBeGreaterThan(0);
  expect(firstChunk).toBeLessThan(offers.length);
  const retry = await acceptOffers(wallet, base.account.market, offers.slice(firstChunk));
  expect(retry.length).toBeGreaterThan(0);
  const retried = submit.mock.calls.slice(2).flatMap(([tx]) => tx.instructions.slice(1));
  expect(retried.map((ix) => ix.keys[3].pubkey.toBase58())).toEqual(
    offers.slice(firstChunk).map((o) => o.publicKey.toBase58()),
  );
});
