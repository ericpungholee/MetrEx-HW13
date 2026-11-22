// Spec §10.3: "Verify early that three instructions fit in one." Real-sized instructions
// built from the committed IDL with dummy pubkeys; no network access.
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { findMarketPda, findOfferPda } from "@metrex/shared";
import { describe, expect, it } from "vitest";
import { buildTransactions, MAX_TX_BYTES, measureTransactionSize, packInstructionGroups } from "../../app/lib/batch";
import { buildAcceptOfferIx, buildClaimPayoutIx, createProgram, describeError, extractErrorCode } from "./client";

// Never contacted: Program construction and .instruction() are offline.
const program = createProgram(new Connection("http://127.0.0.1:1"));
const homeowner = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58(); // any 32-byte base58 value
const [market] = findMarketPda(program.programId, homeowner, 1_700_000_000_000n);

function offerFor(i: number): { offer: PublicKey; underwriter: PublicKey } {
  const underwriter = Keypair.generate().publicKey;
  return { underwriter, offer: findOfferPda(program.programId, market, underwriter, BigInt(i))[0] };
}

async function acceptGroups(n: number) {
  return Promise.all(
    Array.from({ length: n }, async (_, i) => [
      await buildAcceptOfferIx(program, homeowner, market, offerFor(i).offer, mint),
    ]),
  );
}

const ataPrefix = [
  createAssociatedTokenAccountIdempotentInstruction(
    homeowner,
    getAssociatedTokenAddressSync(mint, homeowner, true),
    homeowner,
    mint,
  ),
];

describe("batched transactions (§10.3)", () => {
  it("builds accept_offer from the IDL with the expected shape", async () => {
    const ix = (await acceptGroups(1))[0]?.[0];
    expect(ix!.programId.equals(program.programId)).toBe(true);
    expect(ix!.keys).toHaveLength(7);
    expect(ix!.data.length).toBe(8); // discriminator only, no args
  });

  it("fits 3 accept_offer instructions in ONE transaction", async () => {
    const groups = await acceptGroups(3);
    const batches = packInstructionGroups(groups, { feePayer: homeowner, recentBlockhash: blockhash });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    const [tx] = buildTransactions(batches, homeowner, blockhash);
    const size = measureTransactionSize(tx!.instructions, homeowner, blockhash);
    expect(size).toBeLessThanOrEqual(MAX_TX_BYTES);
    // Cross-check the measurement against web3.js's own serializer.
    expect(tx!.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBe(size);
  });

  it("still fits 3 accepts plus the idempotent ATA prefix in one transaction", async () => {
    const groups = await acceptGroups(3);
    const batches = packInstructionGroups(groups, { feePayer: homeowner, recentBlockhash: blockhash, prefix: ataPrefix });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
  });

  it("fits 3 claim_payout instructions in one transaction", async () => {
    const groups = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const { offer, underwriter } = offerFor(100 + i);
        const surplusToken = getAssociatedTokenAddressSync(mint, underwriter, true);
        const claim = await buildClaimPayoutIx(program, homeowner, market, offer, underwriter, mint, surplusToken);
        expect(claim.keys.at(-1)).toEqual({ pubkey: surplusToken, isSigner: false, isWritable: true });
        return [
          createAssociatedTokenAccountIdempotentInstruction(homeowner, surplusToken, underwriter, mint),
          claim,
        ];
      }),
    );
    const batches = packInstructionGroups(groups, { feePayer: homeowner, recentBlockhash: blockhash, prefix: ataPrefix });
    expect(batches).toHaveLength(1);
  });

  it("auto-splits a large batch into the fewest transactions, each within 1232 bytes", async () => {
    const n = 30;
    const groups = await acceptGroups(n);
    const batches = packInstructionGroups(groups, { feePayer: homeowner, recentBlockhash: blockhash, prefix: ataPrefix });
    expect(batches.length).toBeGreaterThan(1);
    const perTx = batches[0]!.length - ataPrefix.length;
    expect(batches.length).toBe(Math.ceil(n / perTx)); // fewest possible for equal-size groups
    let total = 0;
    for (const b of batches) {
      expect(measureTransactionSize(b, homeowner, blockhash)).toBeLessThanOrEqual(MAX_TX_BYTES);
      total += b.length - ataPrefix.length;
    }
    expect(total).toBe(n);
    // Order preserved.
    const flat = batches.flatMap((b) => b.slice(ataPrefix.length));
    expect(flat).toEqual(groups.flat());
  });
});

describe("error mapping (§10.1)", () => {
  it("maps custom program errors to readable messages", () => {
    expect(extractErrorCode({ InstructionError: [0, { Custom: 6006 }] })).toBe(6006);
    expect(describeError(new Error("failed: custom program error: 0x1776"))).toContain("CoverageExceedsRemaining");
    expect(describeError(new Error("User rejected the request."))).toBe("Transaction cancelled in your wallet.");
  });
});
