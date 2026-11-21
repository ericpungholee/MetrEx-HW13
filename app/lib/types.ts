import type { PublicKey } from "@solana/web3.js";

/** An account with its address, as returned by `program.account.x.all()`. */
export interface Keyed<T> {
  publicKey: PublicKey;
  account: T;
}
