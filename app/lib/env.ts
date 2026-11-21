// Public runtime configuration. Switching to Devnet (or a new deploy) is env-only.
// NEXT_PUBLIC_* must be referenced literally so Next.js inlines them at build time.
import { PublicKey } from "@solana/web3.js";
import idl from "../../target/idl/metrex.json";

function parseKey(value: string | undefined): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value.trim());
  } catch {
    return null;
  }
}

export const USE_FIXTURES = process.env.NEXT_PUBLIC_USE_FIXTURES === "1";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";

/** Defaults to the committed IDL address. */
export const PROGRAM_ID: PublicKey =
  parseKey(process.env.NEXT_PUBLIC_PROGRAM_ID) ?? new PublicKey(idl.address);

/**
 * Display hint only (balance before Config is readable). Every instruction uses the mint
 * read from the on-chain Config PDA (CLAUDE.md "Authority").
 */
export const MUSD_MINT_HINT: PublicKey | null = parseKey(process.env.NEXT_PUBLIC_MUSD_MINT);

/** Poll interval for market and offer accounts (spec §10.1). */
export const POLL_MS = 3_000;
