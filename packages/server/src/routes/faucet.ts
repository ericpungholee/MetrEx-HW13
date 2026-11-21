// POST /api/faucet { wallet }: 0.05 devnet SOL from the faucet wallet and
// 25,000 mUSD minted by the mint authority. One request per wallet per 10 minutes; hard cap
// of 100 distinct wallets per process. State is in memory (no database).

import { SystemProgram, type Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createMintToInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadKeypair } from "../env";
import { fetchExchangeConfig } from "../exchange/accounts";
import { getExchangeProgram } from "../exchange/program";
import { explorerTx } from "../explorer";
import { getRpc, type RpcPool } from "../rpc";
import { createAtaIdempotentIx, getSolLamports, musd, musdAta, solToLamports } from "../token";
import { sendTx } from "../tx";
import { tooMany, unavailable } from "./errors";

export const FAUCET_SOL_LAMPORTS = solToLamports("0.05");
export const FAUCET_MUSD = musd(25_000n);
export const FAUCET_WINDOW_MS = 10 * 60 * 1000;
export const FAUCET_MAX_WALLETS = 100;
/** Keep this much in the faucet wallet for fees. */
export const FAUCET_RESERVE_LAMPORTS = solToLamports("0.01");

/** Pure rate-limit state (unit-tested). */
export class FaucetLimiter {
  private readonly last = new Map<string, number>();
  private recentGrants: number[] = [];
  constructor(
    readonly windowMs = FAUCET_WINDOW_MS,
    readonly maxWallets = FAUCET_MAX_WALLETS,
    readonly grantsPerMinute = 12,
  ) {}

  /** Reserves a wallet slot and consumes one of the shared minute-budget slots. */
  reserve(wallet: string, now: number): void {
    const prev = this.last.get(wallet);
    if (prev !== undefined && now - prev < this.windowMs) {
      const wait = Math.ceil((this.windowMs - (now - prev)) / 1000);
      throw tooMany(`This wallet was funded recently; try again in ${wait} s`);
    }
    if (prev === undefined && this.last.size >= this.maxWallets) {
      throw tooMany("Faucet limit reached for this demo");
    }
    this.recentGrants = this.recentGrants.filter((t) => t > now - 60_000);
    if (this.recentGrants.length >= this.grantsPerMinute) {
      throw tooMany("Faucet request limit reached. Retry in a minute.");
    }
    this.recentGrants.push(now);
    this.last.set(wallet, now);
  }

  release(wallet: string, previous: number | undefined): void {
    if (previous === undefined) this.last.delete(wallet);
    else this.last.set(wallet, previous);
  }

  lastRequest(wallet: string): number | undefined {
    return this.last.get(wallet);
  }

  get size(): number {
    return this.last.size;
  }
}

export interface FaucetResult {
  wallet: string;
  signature: string;
  explorer: string;
  solLamports: string;
  musdBaseUnits: string;
}

export interface FaucetDeps {
  rpc?: RpcPool;
  faucet?: Keypair;
  mintAuthority?: Keypair;
  mint?: PublicKey;
  limiter?: FaucetLimiter;
  now?: () => number;
}

/** Instructions for one faucet payout (shared with scripts/fund-wallet.ts). */
export function faucetInstructions(a: {
  faucet: PublicKey;
  mintAuthority: PublicKey;
  mint: PublicKey;
  wallet: PublicKey;
  solLamports: bigint;
  musdAmount: bigint;
}): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (a.solLamports > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: a.faucet, toPubkey: a.wallet, lamports: a.solLamports }));
  }
  if (a.musdAmount > 0n) {
    ixs.push(createAtaIdempotentIx(a.faucet, a.wallet, a.mint));
    ixs.push(
      createMintToInstruction(a.mint, musdAta(a.wallet, a.mint), a.mintAuthority, a.musdAmount, [], TOKEN_PROGRAM_ID),
    );
  }
  return ixs;
}

const defaultLimiter = new FaucetLimiter();

export async function faucet(wallet: PublicKey, deps: FaucetDeps = {}): Promise<FaucetResult> {
  const limiter = deps.limiter ?? defaultLimiter;
  const now = (deps.now ?? Date.now)();
  const key = wallet.toBase58();
  const previous = limiter.lastRequest(key);
  limiter.reserve(key, now);
  let submissionStarted = false;
  try {
    const rpc = deps.rpc ?? getRpc();
    const faucetKp = deps.faucet ?? loadKeypair("faucet");
    const mintAuthority = deps.mintAuthority ?? loadKeypair("mintAuthority");
    const mint = deps.mint ?? (await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "finalized")))?.collateralMint;
    if (!mint) throw unavailable("Exchange collateral mint unavailable");
    const bal = await rpc.run((c) => getSolLamports(c, faucetKp.publicKey));
    if (bal < FAUCET_SOL_LAMPORTS + FAUCET_RESERVE_LAMPORTS) throw unavailable("Faucet wallet is out of SOL");
    const ixs = faucetInstructions({
      faucet: faucetKp.publicKey,
      mintAuthority: mintAuthority.publicKey,
      mint,
      wallet,
      solLamports: FAUCET_SOL_LAMPORTS,
      musdAmount: FAUCET_MUSD,
    });
    submissionStarted = true;
    const signature = await sendTx(rpc.connection, ixs, [faucetKp, mintAuthority], { attempts: 1 });
    return {
      wallet: key,
      signature,
      explorer: explorerTx(signature),
      solLamports: FAUCET_SOL_LAMPORTS.toString(),
      musdBaseUnits: FAUCET_MUSD.toString(),
    };
  } catch (e) {
    // Once a submission starts, a transport failure can hide a landed grant.
    if (!submissionStarted) limiter.release(key, previous);
    throw e;
  }
}
