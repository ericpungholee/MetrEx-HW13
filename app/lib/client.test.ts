import { Keypair, type VersionedTransactionResponse } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
import idl from "../../target/idl/metrex.json";
import { createMarket, fetchActivity, getConnection, IDL, type WalletSigner } from "./client";

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
