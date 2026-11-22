import { utils } from "@anchor-lang/core";
import { Transaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { readDemoFile, writeDemoFile } from "./demo-state";
import type { RpcPool } from "../rpc";

interface PendingTransaction {
  raw: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

interface SavedTransaction {
  pending?: PendingTransaction;
  signature?: string;
}

/**
 * Record signed bytes before broadcasting. A restart may broadcast those same bytes again,
 * and may only sign replacement bytes once a finalized block proves expiry.
 * Callers serialize writes to the journal and give each logical transfer its own key.
 */
export class DemoTransactions {
  private readonly records: Record<string, SavedTransaction>;

  constructor(private readonly rpc: RpcPool, private readonly file: string) {
    this.records = readDemoFile(file) ?? {};
  }

  async recover(): Promise<void> {
    for (const [key, record] of Object.entries(this.records)) {
      if (record.pending) await this.resume(key, record.pending);
    }
  }

  async send(key: string, build: () => Promise<{
    instructions: TransactionInstruction[];
    signers: Keypair[];
  } | null>): Promise<string | undefined> {
    const record = this.records[key] ?? {};
    if (record.signature) return record.signature;
    if (record.pending) {
      const sig = await this.resume(key, record.pending);
      if (sig) return sig;
    }
    const tx = await build();
    if (!tx) return;
    const block = await this.rpc.run((c) => c.getLatestBlockhash("confirmed"));
    const signed = new Transaction({ feePayer: tx.signers[0]!.publicKey, ...block }).add(...tx.instructions);
    signed.sign(...tx.signers);
    const pending = { ...block, raw: signed.serialize().toString("base64") };
    this.save(key, { pending });
    const sig = await this.resume(key, pending);
    if (!sig) throw new Error(`Transaction expired before ${key}. Retry the operation.`);
    return sig;
  }

  private async resume(key: string, pending: PendingTransaction): Promise<string | undefined> {
    const raw = Buffer.from(pending.raw, "base64");
    // web3.js returns the signature in base58 via the transaction's JSON-RPC response.
    // Derive it locally so status checks work even when sending timed out.
    const sig = utils.bytes.bs58.encode(Transaction.from(raw).signature!);
    const status = await this.rpc.run((c) => c.getSignatureStatus(sig, { searchTransactionHistory: true }));
    if (status.value?.confirmationStatus === "finalized") {
      if (status.value.err) {
        this.save(key, {});
        throw new Error(`Transaction ${sig} failed for ${key}. Retry the operation.`);
      }
      this.save(key, { signature: sig });
      return sig;
    }
    if (await this.rpc.run((c) => c.getBlockHeight("finalized")) > pending.lastValidBlockHeight) {
      // Check again after reading the finalized height to cover a transaction that landed
      // between the first status response and the block-height response.
      const last = await this.rpc.run((c) => c.getSignatureStatus(sig, { searchTransactionHistory: true }));
      if (last.value?.confirmationStatus === "finalized" && !last.value.err) {
        this.save(key, { signature: sig });
        return sig;
      }
      if (last.value && last.value.confirmationStatus !== "finalized") {
        throw new Error(`Waiting for ${key} transaction ${sig} to finalize. Retry the operation.`);
      }
      this.save(key, {});
      return;
    }
    if (!status.value) {
      await this.rpc.run((c) => c.sendRawTransaction(raw, { preflightCommitment: "confirmed" }));
    }
    const confirmation = await this.rpc.run((c) => c.confirmTransaction({
      signature: sig, blockhash: pending.blockhash, lastValidBlockHeight: pending.lastValidBlockHeight,
    }, "finalized"));
    if (confirmation.value.err) {
      this.save(key, {});
      throw new Error(`Transaction ${sig} failed for ${key}. Retry the operation.`);
    }
    this.save(key, { signature: sig });
    return sig;
  }

  private save(key: string, record: SavedTransaction): void {
    this.records[key] = record;
    writeDemoFile(this.file, this.records);
  }
}

