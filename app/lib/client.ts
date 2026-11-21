// ALL chain access for the frontend goes through this module (CLAUDE.md).
// Reads: config, properties, markets, offers, listings, balances, activity (events).
// Writes: build + sign with the connected wallet + send, returning signatures.
// In fixture mode reads come from lib/fixtures.ts and every write throws FixtureModeError.
import { BN, BorshCoder, EventParser, Program, type Idl } from "@anchor-lang/core";
import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type SendOptions,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ERROR_MESSAGES,
  errorNameOf,
  findConfigPda,
  findListingPda,
  findMarketPda,
  findOfferPda,
  findPropertyPda,
  findVaultPda,
  marketStatusOf,
  offerStatusOf,
  randomNonce,
  Side,
  type ConfigAccount,
  type ListingAccount,
  type MarketAccount,
  type OfferAccount,
  type PropertyAccount,
} from "@metrex/shared";
import idlJson from "../../target/idl/metrex.json";
import type { Metrex } from "../../target/types/metrex";
import { buildTransactions, packInstructionGroups } from "./batch";
import { MUSD_MINT_HINT, PROGRAM_ID, RPC_URL, USE_FIXTURES } from "./env";
import { getFixtureState, FIXTURE_VIEWER } from "./fixtures";
import { explorerTx } from "./format";
import type { Keyed } from "./types";

export type { Keyed } from "./types";
export { PROGRAM_ID, RPC_URL, USE_FIXTURES } from "./env";
export { FIXTURE_VIEWER } from "./fixtures";

// ---------------------------------------------------------------------------
// Program + connection
// ---------------------------------------------------------------------------

/** The committed IDL with the address overridden by NEXT_PUBLIC_PROGRAM_ID when set. */
export const IDL: Metrex = { ...(idlJson as unknown as Metrex), address: PROGRAM_ID.toBase58() } as Metrex;

let connection: Connection | null = null;
let program: Program<Metrex> | null = null;

export function getConnection(): Connection {
  connection ??= new Connection(RPC_URL, "confirmed");
  return connection;
}

/** Read-only program client (no wallet needed: reads and instruction building only). */
export function getProgram(): Program<Metrex> {
  program ??= new Program<Metrex>(IDL, { connection: getConnection() });
  return program;
}

/** Build a program client on any connection (used by tests and bots-style callers). */
export function createProgram(conn: Connection): Program<Metrex> {
  return new Program<Metrex>(IDL, { connection: conn });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FixtureModeError extends Error {
  constructor() {
    super("Fixture mode: transactions disabled");
    this.name = "FixtureModeError";
  }
}

function assertLive(): void {
  if (USE_FIXTURES) throw new FixtureModeError();
}

function collectErrorText(err: unknown): string {
  if (!err) return "";
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  const anyErr = err as { logs?: unknown; transactionLogs?: unknown; transactionMessage?: unknown };
  for (const logs of [anyErr.logs, anyErr.transactionLogs]) {
    if (Array.isArray(logs)) parts.push(logs.join("\n"));
  }
  if (typeof anyErr.transactionMessage === "string") parts.push(anyErr.transactionMessage);
  if (!(err instanceof Error)) {
    try {
      parts.push(typeof err === "string" ? err : JSON.stringify(err));
    } catch {
      parts.push(String(err));
    }
  }
  return parts.join("\n");
}

/** Extract a MetrEx custom error code (6000+) from any error shape, if present. */
export function extractErrorCode(err: unknown): number | undefined {
  const asObj = err as { InstructionError?: [number, { Custom?: number }] } | undefined;
  const custom = asObj?.InstructionError?.[1]?.Custom;
  if (typeof custom === "number") return custom;
  const text = collectErrorText(err);
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (hex?.[1]) return parseInt(hex[1], 16);
  const num = /Error Number: (\d+)/.exec(text);
  if (num?.[1]) return Number(num[1]);
  const json = /"Custom":(\d+)/.exec(text);
  if (json?.[1]) return Number(json[1]);
  return undefined;
}

/** Readable message for any transaction or RPC error (spec §10.1). */
export function describeError(err: unknown): string {
  if (err instanceof FixtureModeError) return err.message;
  const code = extractErrorCode(err);
  if (code !== undefined) {
    const name = errorNameOf(code);
    if (name) return `${ERROR_MESSAGES[name]} (${name})`;
  }
  const text = collectErrorText(err);
  if (/user rejected|rejected the request|declined/i.test(text)) return "Transaction cancelled in your wallet.";
  if (/insufficient lamports|insufficient funds for fee|Attempt to debit an account but found no record/i.test(text)) {
    return "Not enough devnet SOL to pay the network fee. Use \"Get demo funds\".";
  }
  if (/insufficient funds/i.test(text)) return "Not enough mUSD in your wallet.";
  if (/block height exceeded|expired/i.test(text)) return "The transaction expired before it confirmed. Try again.";
  if (/AccountNotInitialized|could not find account|Account does not exist/i.test(text)) {
    return "A required account doesn't exist yet (has the program been initialized on this cluster?).";
  }
  const first = (err instanceof Error ? err.message : text).split("\n")[0] ?? "Unknown error";
  return first.length > 240 ? `${first.slice(0, 240)}…` : first;
}

// ---------------------------------------------------------------------------
// Latency (spec §10.5: median client-measured send→confirm latency of your own txs)
// ---------------------------------------------------------------------------

const latencies: number[] = [];

export function getLatencies(): readonly number[] {
  return latencies;
}

export function medianLatencyMs(): number | null {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// ---------------------------------------------------------------------------
// Casting helpers: Anchor's decoded IDL types → @metrex/shared account types
// ---------------------------------------------------------------------------

function keyed<T>(rows: { publicKey: PublicKey; account: unknown }[]): Keyed<T>[] {
  return rows.map((r) => ({ publicKey: r.publicKey, account: r.account as T }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

let configCache: ConfigAccount | null = null;

export async function fetchConfig(): Promise<ConfigAccount | null> {
  if (USE_FIXTURES) return (await getFixtureState(PROGRAM_ID)).config;
  if (configCache) return configCache;
  const [pda] = findConfigPda(PROGRAM_ID);
  const acc = await getProgram().account.config.fetchNullable(pda);
  configCache = (acc as unknown as ConfigAccount | null) ?? null;
  return configCache;
}

/** The mUSD mint, always from the Config PDA (env value is only a display fallback). */
export async function getMint(): Promise<PublicKey> {
  const config = await fetchConfig();
  if (config) return config.mint;
  throw new Error("Config account not found: the program is not initialized on this cluster yet.");
}

export async function fetchProperties(): Promise<Keyed<PropertyAccount>[]> {
  if (USE_FIXTURES) return (await getFixtureState(PROGRAM_ID)).properties;
  const rows = await getProgram().account.property.all();
  return keyed<PropertyAccount>(rows).sort((a, b) => a.account.propertyId - b.account.propertyId);
}

export async function fetchMarkets(): Promise<Keyed<MarketAccount>[]> {
  if (USE_FIXTURES) return (await getFixtureState(PROGRAM_ID)).markets;
  const rows = await getProgram().account.market.all();
  return keyed<MarketAccount>(rows).sort((a, b) => b.account.createdAt.cmp(a.account.createdAt));
}

export async function fetchMarket(market: PublicKey): Promise<Keyed<MarketAccount> | null> {
  if (USE_FIXTURES) {
    return (await getFixtureState(PROGRAM_ID)).markets.find((m) => m.publicKey.equals(market)) ?? null;
  }
  const acc = await getProgram().account.market.fetchNullable(market);
  return acc ? { publicKey: market, account: acc as unknown as MarketAccount } : null;
}

/** Offers for one market: memcmp on `Offer.market` (offset 8, after the discriminator). */
export async function fetchOffersByMarket(market: PublicKey): Promise<Keyed<OfferAccount>[]> {
  if (USE_FIXTURES) {
    return (await getFixtureState(PROGRAM_ID)).offers.filter((o) => o.account.market.equals(market));
  }
  const rows = await getProgram().account.offer.all([
    { memcmp: { offset: 8, bytes: market.toBase58() } },
  ]);
  return keyed<OfferAccount>(rows);
}

export async function fetchAllOffers(): Promise<Keyed<OfferAccount>[]> {
  if (USE_FIXTURES) return (await getFixtureState(PROGRAM_ID)).offers;
  return keyed<OfferAccount>(await getProgram().account.offer.all());
}

export async function fetchListings(): Promise<Keyed<ListingAccount>[]> {
  if (USE_FIXTURES) return (await getFixtureState(PROGRAM_ID)).listings;
  return keyed<ListingAccount>(await getProgram().account.listing.all());
}

/** Listings whose `offer` is one of these (single getProgramAccounts call, filtered locally). */
export async function fetchListingsForOffers(offers: PublicKey[]): Promise<Keyed<ListingAccount>[]> {
  const set = new Set(offers.map((o) => o.toBase58()));
  return (await fetchListings()).filter((l) => set.has(l.account.offer.toBase58()));
}

export interface ExchangeSnapshot {
  markets: Keyed<MarketAccount>[];
  offers: Keyed<OfferAccount>[];
  properties: Keyed<PropertyAccount>[];
}

export async function fetchExchange(): Promise<ExchangeSnapshot> {
  const [markets, offers, properties] = await Promise.all([fetchMarkets(), fetchAllOffers(), fetchProperties()]);
  return { markets, offers, properties };
}

export interface MarketSnapshot {
  market: Keyed<MarketAccount> | null;
  property: Keyed<PropertyAccount> | null;
  offers: Keyed<OfferAccount>[];
  listings: Keyed<ListingAccount>[];
}

export async function fetchMarketSnapshot(market: PublicKey): Promise<MarketSnapshot> {
  const [m, offers, listings] = await Promise.all([fetchMarket(market), fetchOffersByMarket(market), fetchListings()]);
  let property: Keyed<PropertyAccount> | null = null;
  if (m) {
    if (USE_FIXTURES) {
      property =
        (await getFixtureState(PROGRAM_ID)).properties.find((p) => p.account.propertyId === m.account.propertyId) ??
        null;
    } else {
      const pda = findPropertyPda(PROGRAM_ID, m.account.propertyId)[0];
      const acc = await getProgram().account.property.fetchNullable(pda);
      property = acc ? { publicKey: pda, account: acc as unknown as PropertyAccount } : null;
    }
  }
  const offerSet = new Set(offers.map((o) => o.publicKey.toBase58()));
  return { market: m, property, offers, listings: listings.filter((l) => offerSet.has(l.account.offer.toBase58())) };
}

/** mUSD balance in base units; 0n when the wallet has no mUSD account yet. */
export async function fetchMusdBalance(owner: PublicKey): Promise<bigint> {
  if (USE_FIXTURES) return (await getFixtureState(PROGRAM_ID)).balances.get(owner.toBase58()) ?? 0n;
  let mint: PublicKey;
  try {
    mint = await getMint();
  } catch (e) {
    if (!MUSD_MINT_HINT) throw e;
    mint = MUSD_MINT_HINT;
  }
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const info = await getConnection().getAccountInfo(ata);
  if (!info) return 0n;
  const bal = await getConnection().getTokenAccountBalance(ata);
  return BigInt(bal.value.amount);
}

/** SOL balance in lamports (for the "Get demo funds" prompt). */
export async function fetchSolLamports(owner: PublicKey): Promise<bigint> {
  if (USE_FIXTURES) return BigInt(LAMPORTS_PER_SOL);
  return BigInt(await getConnection().getBalance(owner));
}

export interface ActivityItem {
  signature: string;
  slot: number;
  blockTime: number | null;
  name: string;
  data: Record<string, unknown>;
}

const parsedTxCache = new Map<string, ActivityItem[]>();
let eventParser: EventParser | null = null;

function getEventParser(): EventParser {
  eventParser ??= new EventParser(PROGRAM_ID, new BorshCoder(IDL as unknown as Idl));
  return eventParser;
}

/** Decode program events from raw log lines (pure; exposed for tests). */
export function parseEventsFromLogs(logs: string[]): { name: string; data: Record<string, unknown> }[] {
  const out: { name: string; data: Record<string, unknown> }[] = [];
  try {
    for (const ev of getEventParser().parseLogs(logs)) {
      out.push({ name: ev.name, data: ev.data as Record<string, unknown> });
    }
  } catch {
    // best effort: a log we can't decode doesn't break the feed
  }
  return out;
}

/**
 * Activity feed (spec §6.5): program events from recent transactions touching `address`
 * (a market, or a wallet). Best effort; account state remains the source of truth.
 * Parsed transactions are cached by signature, so each poll only fetches new ones.
 */
export async function fetchActivity(address: PublicKey, limit = 25): Promise<ActivityItem[]> {
  if (USE_FIXTURES) return fixtureActivity(address);
  const conn = getConnection();
  const sigs = await conn.getSignaturesForAddress(address, { limit });
  const missing = sigs.filter((s) => !parsedTxCache.has(s.signature) && !s.err);
  if (missing.length > 0) {
    const txs = await conn.getTransactions(
      missing.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );
    const requested = new Set(missing.map((item) => item.signature));
    for (const tx of txs) {
      const signature = tx?.transaction.signatures[0];
      // Batch JSON-RPC responses may arrive in a different order from the requests.
      if (!tx || !signature || !requested.has(signature)) continue;
      const events = parseEventsFromLogs(tx.meta?.logMessages ?? []);
      parsedTxCache.set(
        signature,
        events.map((e) => ({ signature, slot: tx.slot, blockTime: tx.blockTime ?? null, ...e })),
      );
    }
  }
  return sigs.flatMap((s) => parsedTxCache.get(s.signature) ?? []);
}

async function fixtureActivity(address: PublicKey): Promise<ActivityItem[]> {
  const st = await getFixtureState(PROGRAM_ID);
  const offers = st.offers.filter((o) => o.account.market.equals(address));
  const names: Record<string, string> = {
    open: "OfferPlaced",
    accepted: "OfferAccepted",
    cancelled: "OfferCancelled",
    claimed: "PayoutClaimed",
    refunded: "OfferRefunded",
  };
  return offers.map((o, i) => ({
    signature: `FIXTURE-${i}`,
    slot: 0,
    blockTime: o.account.createdAt.toNumber(),
    name: names[offerStatusOf(o.account.status)] ?? "OfferPlaced",
    data: {
      market: address,
      offer: o.publicKey,
      underwriter: o.account.underwriter,
      claimant: o.account.riskHolder,
      coverage: o.account.coverage,
      amount: o.account.coverage,
      refunded: o.account.collateral,
      premium_bps: o.account.premiumBps,
      premium: o.account.premium,
      collateral: o.account.collateral,
    },
  }));
}

/** Evidence record served by Workstream D (GET /api/evidence/[market]); raw bytes as text. */
export async function fetchEvidenceText(market: PublicKey): Promise<string | null> {
  if (USE_FIXTURES) return (await getFixtureState(PROGRAM_ID)).evidence.get(market.toBase58()) ?? null;
  const res = await fetch(`/api/evidence/${market.toBase58()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return await res.text();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Browser wallets can submit with the connection so Wallet Standard receives the chain. */
export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]>;
  sendTransaction?(tx: Transaction, connection: Connection, options?: SendOptions): Promise<string>;
}

export interface TxResult {
  signature: string;
  explorerUrl: string;
  latencyMs: number;
}

export type TxProgress =
  | { stage: "building" }
  | { stage: "signing"; total: number }
  | { stage: "sending"; index: number; total: number }
  | { stage: "confirmed"; index: number; total: number; result: TxResult };

export interface WriteOptions {
  onProgress?: (p: TxProgress) => void;
}

/** Raised after some transactions of a batch confirmed and a later one failed. */
export class PartialBatchError extends Error {
  constructor(
    public readonly confirmed: TxResult[],
    public override readonly cause: unknown,
  ) {
    super(`${confirmed.length} transaction(s) confirmed, then: ${describeError(cause)}`);
    this.name = "PartialBatchError";
  }
}

async function ataIfMissing(payer: PublicKey, owner: PublicKey, mint: PublicKey): Promise<TransactionInstruction[]> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const info = await getConnection().getAccountInfo(ata);
  if (info) return [];
  return [createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint)];
}

/**
 * Pack, sign, submit and confirm. Each packed browser transaction has one wallet prompt.
 */
async function sendGroups(
  wallet: WalletSigner,
  groups: TransactionInstruction[][],
  prefix: TransactionInstruction[],
  opts?: WriteOptions,
): Promise<TxResult[]> {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const batches = packInstructionGroups(groups, { feePayer: wallet.publicKey, recentBlockhash: blockhash, prefix });
  const txs = buildTransactions(batches, wallet.publicKey, blockhash);
  opts?.onProgress?.({ stage: "signing", total: txs.length });
  const sendTransaction = wallet.sendTransaction?.bind(wallet);
  const signed = sendTransaction
    ? undefined
    : txs.length === 1
      ? [await wallet.signTransaction(txs[0]!)]
      : await wallet.signAllTransactions(txs);

  const results: TxResult[] = [];
  for (const [i, tx] of txs.entries()) {
    try {
      // Wallet Standard may sign and submit in a single call.
      const sendOptions = { preflightCommitment: "confirmed" } as const;
      const walletSignature = sendTransaction ? await sendTransaction(tx, conn, sendOptions) : undefined;
      opts?.onProgress?.({ stage: "sending", index: i, total: txs.length });
      const t0 = performance.now();
      const signature = walletSignature ?? await conn.sendRawTransaction(signed![i]!.serialize(), sendOptions);
      const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw conf.value.err;
      const latencyMs = Math.round(performance.now() - t0);
      latencies.push(latencyMs);
      const result = { signature, explorerUrl: explorerTx(signature), latencyMs };
      results.push(result);
      opts?.onProgress?.({ stage: "confirmed", index: i, total: txs.length, result });
    } catch (e) {
      if (results.length > 0) throw new PartialBatchError(results, e);
      throw e;
    }
  }
  return results;
}

/** Create a market on a registered property (spec §6). nonce = Date.now(). */
export async function createMarket(
  wallet: WalletSigner,
  propertyId: number,
  coverage: bigint,
  opts?: WriteOptions,
): Promise<{ market: PublicKey; results: TxResult[] }> {
  assertLive();
  opts?.onProgress?.({ stage: "building" });
  const nonce = new BN(Date.now());
  const [market] = findMarketPda(PROGRAM_ID, wallet.publicKey, BigInt(nonce.toString()));
  const ix = await getProgram()
    .methods.createMarket(nonce, propertyId, new BN(coverage.toString()))
    .accountsStrict({
      homeowner: wallet.publicKey,
      property: findPropertyPda(PROGRAM_ID, propertyId)[0],
      market,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { market, results: await sendGroups(wallet, [[ix]], [], opts) };
}

/** Place a fully collateralized offer. Callers pass only coverage and bps (spec §4.2). */
export async function placeOffer(
  wallet: WalletSigner,
  market: PublicKey,
  coverage: bigint,
  bps: number,
  opts?: WriteOptions,
): Promise<{ offer: PublicKey; results: TxResult[] }> {
  assertLive();
  opts?.onProgress?.({ stage: "building" });
  const mint = await getMint();
  const nonce = randomNonce();
  const [offer] = findOfferPda(PROGRAM_ID, market, wallet.publicKey, nonce);
  const prefix = await ataIfMissing(wallet.publicKey, wallet.publicKey, mint);
  const ix = await getProgram()
    .methods.placeOffer(new BN(nonce.toString()), new BN(coverage.toString()), bps)
    .accountsStrict({
      underwriter: wallet.publicKey,
      config: findConfigPda(PROGRAM_ID)[0],
      market,
      offer,
      mint,
      vault: findVaultPda(PROGRAM_ID, offer)[0],
      underwriterToken: getAssociatedTokenAddressSync(mint, wallet.publicKey, true),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { offer, results: await sendGroups(wallet, [[ix]], prefix, opts) };
}

export async function cancelOffer(
  wallet: WalletSigner,
  offer: Keyed<OfferAccount>,
  opts?: WriteOptions,
): Promise<TxResult[]> {
  assertLive();
  opts?.onProgress?.({ stage: "building" });
  const mint = await getMint();
  const prefix = await ataIfMissing(wallet.publicKey, wallet.publicKey, mint);
  const ix = await getProgram()
    .methods.cancelOffer()
    .accountsStrict({
      underwriter: wallet.publicKey,
      config: findConfigPda(PROGRAM_ID)[0],
      offer: offer.publicKey,
      vault: findVaultPda(PROGRAM_ID, offer.publicKey)[0],
      underwriterToken: getAssociatedTokenAddressSync(mint, wallet.publicKey, true),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return sendGroups(wallet, [[ix]], prefix, opts);
}

/** Build one `accept_offer` instruction (pure; used by acceptOffers and the batch test). */
export async function buildAcceptOfferIx(
  prog: Program<Metrex>,
  homeowner: PublicKey,
  market: PublicKey,
  offer: PublicKey,
  mint: PublicKey,
): Promise<TransactionInstruction> {
  const programId = prog.programId;
  return prog.methods
    .acceptOffer()
    .accountsStrict({
      homeowner,
      config: findConfigPda(programId)[0],
      market,
      offer,
      vault: findVaultPda(programId, offer)[0],
      homeownerToken: getAssociatedTokenAddressSync(mint, homeowner, true),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Build one `claim_payout` instruction (pure). */
export async function buildClaimPayoutIx(
  prog: Program<Metrex>,
  claimant: PublicKey,
  market: PublicKey,
  offer: PublicKey,
  underwriter: PublicKey,
  mint: PublicKey,
  surplusToken?: PublicKey,
): Promise<TransactionInstruction> {
  const programId = prog.programId;
  return prog.methods
    .claimPayout()
    .accountsStrict({
      claimant,
      config: findConfigPda(programId)[0],
      market,
      offer,
      vault: findVaultPda(programId, offer)[0],
      claimantToken: getAssociatedTokenAddressSync(mint, claimant, true),
      underwriter,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(surplusToken ? [{ pubkey: surplusToken, isSigner: false, isWritable: true }] : [])
    .instruction();
}

/**
 * "Accept selected" (spec §10.3): one `accept_offer` per offer, packed into the fewest
 * transactions (one, for three offers). Signed with a single wallet prompt.
 */
export async function acceptOffers(
  wallet: WalletSigner,
  market: PublicKey,
  offers: Keyed<OfferAccount>[],
  opts?: WriteOptions,
): Promise<TxResult[]> {
  assertLive();
  if (offers.length === 0) return [];
  opts?.onProgress?.({ stage: "building" });
  const mint = await getMint();
  const prog = getProgram();
  const prefix = await ataIfMissing(wallet.publicKey, wallet.publicKey, mint);
  const groups = await Promise.all(
    offers.map(async (o) => [await buildAcceptOfferIx(prog, wallet.publicKey, market, o.publicKey, mint)]),
  );
  return sendGroups(wallet, groups, prefix, opts);
}

export interface ClaimablePosition {
  market: Keyed<MarketAccount>;
  offer: Keyed<OfferAccount>;
}

/** Positions the wallet can claim now: resolved market, Accepted offer, holds the winning side. */
export function claimablePositions(
  wallet: PublicKey,
  markets: Keyed<MarketAccount>[],
  offers: Keyed<OfferAccount>[],
): ClaimablePosition[] {
  const byKey = new Map(markets.map((m) => [m.publicKey.toBase58(), m]));
  const out: ClaimablePosition[] = [];
  for (const o of offers) {
    if (offerStatusOf(o.account.status) !== "accepted") continue;
    const m = byKey.get(o.account.market.toBase58());
    if (!m) continue;
    const st = marketStatusOf(m.account.status);
    const winner =
      st === "resolvedYes" ? o.account.protectionHolder : st === "resolvedNo" ? o.account.riskHolder : null;
    if (winner && winner.equals(wallet)) out.push({ market: m, offer: o });
  }
  return out;
}

/** A claimant can provision a surplus account even if the usual ATA has changed authority. */
async function prepareClaimSurplus(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  const conn = getConnection();
  const address = getAssociatedTokenAddressSync(mint, owner, true);
  const info = await conn.getAccountInfo(address);
  if (!info) {
    return {
      address,
      setup: [createAssociatedTokenAccountIdempotentInstruction(payer, address, owner, mint)],
    };
  }
  try {
    const account = unpackAccount(address, info);
    if (account.owner.equals(owner) && account.mint.equals(mint) && !account.isFrozen) {
      return {
        address,
        setup: [createAssociatedTokenAccountIdempotentInstruction(payer, address, owner, mint)],
      };
    }
  } catch {
    // The funded address may contain another account type. Use a fresh token account instead.
  }
  return prepareTemporaryTokenAccount(payer, owner, mint);
}

async function prepareTemporaryTokenAccount(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  const seed = `metrex-${randomNonce().toString(16)}`;
  const address = await PublicKey.createWithSeed(payer, seed, TOKEN_PROGRAM_ID);
  return {
    address,
    setup: [
      SystemProgram.createAccountWithSeed({
        fromPubkey: payer,
        basePubkey: payer,
        newAccountPubkey: address,
        seed,
        lamports: await getConnection().getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(address, mint, owner),
    ],
  };
}

/** "Claim all" (spec §10.3): every claimable `claim_payout`, batched like acceptOffers. */
export async function claimAll(
  wallet: WalletSigner,
  positions: ClaimablePosition[],
  opts?: WriteOptions,
): Promise<TxResult[]> {
  assertLive();
  if (positions.length === 0) return [];
  opts?.onProgress?.({ stage: "building" });
  const mint = await getMint();
  const prog = getProgram();
  const prefix = await ataIfMissing(wallet.publicKey, wallet.publicKey, mint);
  const groups = await Promise.all(positions.map(async ({ market, offer }) => {
    const underwriter = offer.account.underwriter;
    const owner = wallet.publicKey.equals(underwriter) ? market.account.homeowner : underwriter;
    const surplus = await prepareClaimSurplus(wallet.publicKey, owner, mint);
    const claim = await buildClaimPayoutIx(
      prog, wallet.publicKey, market.publicKey, offer.publicKey, underwriter, mint, surplus.address,
    );
    return [...surplus.setup, claim];
  }));
  return sendGroups(wallet, groups, prefix, opts);
}

/** Tier 2: list one side of an accepted position for `price` mUSD base units. */
export async function listPosition(
  wallet: WalletSigner,
  offer: Keyed<OfferAccount>,
  side: Side,
  price: bigint,
  opts?: WriteOptions,
): Promise<TxResult[]> {
  assertLive();
  opts?.onProgress?.({ stage: "building" });
  const ix = await getProgram()
    .methods.listPosition(side, new BN(price.toString()))
    .accountsStrict({
      seller: wallet.publicKey,
      market: offer.account.market,
      offer: offer.publicKey,
      listing: findListingPda(PROGRAM_ID, offer.publicKey, side)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return sendGroups(wallet, [[ix]], [], opts);
}

/** Buy the listed side at the displayed price in one transaction. */
export async function buyPosition(
  wallet: WalletSigner,
  listing: Keyed<ListingAccount>,
  offer: Keyed<OfferAccount>,
  opts?: WriteOptions,
): Promise<TxResult[]> {
  assertLive();
  opts?.onProgress?.({ stage: "building" });
  const mint = await getMint();
  const seller = listing.account.seller;
  const prefix = [
    ...(await ataIfMissing(wallet.publicKey, wallet.publicKey, mint)),
    ...(await ataIfMissing(wallet.publicKey, seller, mint)),
  ];
  // A listing PDA can be reused after cancellation. Fund only the displayed
  // price, then require the payment account to close empty in the same transaction.
  const buyer = wallet.publicKey;
  const payment = await prepareTemporaryTokenAccount(buyer, buyer, mint);
  const fund = createTransferInstruction(
    getAssociatedTokenAddressSync(mint, buyer, true),
    payment.address,
    buyer,
    BigInt(listing.account.price.toString()),
  );
  const ix = await getProgram()
    .methods.buyPosition()
    .accountsStrict({
      buyer: wallet.publicKey,
      config: findConfigPda(PROGRAM_ID)[0],
      market: offer.account.market,
      offer: offer.publicKey,
      listing: listing.publicKey,
      seller,
      buyerToken: payment.address,
      sellerToken: getAssociatedTokenAddressSync(mint, seller, true),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const close = createCloseAccountInstruction(payment.address, buyer, buyer);
  return sendGroups(wallet, [[...payment.setup, fund, ix, close]], prefix, opts);
}

/** Tier 2: cancel your own listing (rent back to you). */
export async function cancelListing(
  wallet: WalletSigner,
  listing: Keyed<ListingAccount>,
  opts?: WriteOptions,
): Promise<TxResult[]> {
  assertLive();
  opts?.onProgress?.({ stage: "building" });
  const ix = await getProgram()
    .methods.cancelListing()
    .accountsStrict({ seller: wallet.publicKey, listing: listing.publicKey })
    .instruction();
  return sendGroups(wallet, [[ix]], [], opts);
}

// ---------------------------------------------------------------------------
// Backend calls (Workstream D route handlers)
// ---------------------------------------------------------------------------

export interface ApiResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  if (USE_FIXTURES) throw new FixtureModeError();
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed, text };
}

/** POST /api/faucet { wallet } (spec §9.3). */
export function requestFaucet(wallet: PublicKey): Promise<ApiResult> {
  return postJson("/api/faucet", { wallet: wallet.toBase58() });
}

/** POST /api/demo/close/[market] with the operator's demo password header. */
export function requestCloseMarket(market: PublicKey, demoPassword: string): Promise<ApiResult> {
  return postJson(`/api/demo/close/${market.toBase58()}`, {}, { "x-demo-password": demoPassword });
}

/** POST /api/oracle/resolve/[market] with the operator's demo password header. */
export function requestResolveMarket(market: PublicKey, demoPassword: string): Promise<ApiResult> {
  return postJson(`/api/oracle/resolve/${market.toBase58()}`, {}, { "x-demo-password": demoPassword });
}

export interface NetworkStats {
  txTotal: number | null;
  txLast10Min: number | null;
  feesSol: string | null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Lamports (integer) → SOL string, exact. */
function lamportsToSol(lamports: bigint): string {
  const whole = lamports / BigInt(LAMPORTS_PER_SOL);
  const frac = (lamports % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * GET /api/stats (Workstream D). Accepts `{ txTotal, txLast10Min, totalFeesLamports }`
 * (plus a few aliases). Returns null when unavailable.
 */
export async function fetchNetworkStats(): Promise<NetworkStats | null> {
  if (USE_FIXTURES) return null;
  try {
    const res = await fetch("/api/stats", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const feesLamportsRaw = j.totalFeesLamports ?? j.feesLamports ?? j.total_fees_lamports;
    let feesSol: string | null = null;
    if (typeof feesLamportsRaw === "number" || typeof feesLamportsRaw === "string") {
      try {
        feesSol = lamportsToSol(BigInt(feesLamportsRaw));
      } catch {
        feesSol = null;
      }
    } else if (typeof j.totalFeesSol === "number" || typeof j.totalFeesSol === "string") {
      feesSol = String(j.totalFeesSol);
    }
    return {
      txTotal: pickNumber(j, ["txTotal", "total", "programTxTotal", "tx_total"]),
      txLast10Min: pickNumber(j, ["txLast10Min", "last10Min", "programTxLast10Min", "tx_last_10_min"]),
      feesSol,
    };
  } catch {
    return null;
  }
}

/** Resolve the signer for a write: fixture mode always refuses; otherwise a wallet is required. */
export function requireSigner(wallet: WalletSigner | null | undefined): WalletSigner {
  if (USE_FIXTURES) throw new FixtureModeError();
  if (!wallet) throw new Error("Connect a wallet first.");
  return wallet;
}

/** In fixture mode, pages without a connected wallet view as this fixture wallet. */
export function viewerFor(connected: PublicKey | null | undefined): PublicKey | null {
  if (connected) return connected;
  return USE_FIXTURES ? FIXTURE_VIEWER : null;
}
