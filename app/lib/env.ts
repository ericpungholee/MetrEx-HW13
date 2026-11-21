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

/**
 * The browser's RPC endpoint. Defaults to this app's own /api/rpc proxy, which forwards an
 * allowlist of methods to the server's RPC_URL so a provider key never reaches the browser.
 * NEXT_PUBLIC_RPC_URL overrides it (only ever with a key-free URL). The public Devnet endpoint is
 * used only during server rendering, where nothing is fetched.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || (typeof window !== "undefined" ? `${window.location.origin}/api/rpc` : "https://api.devnet.solana.com");

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

/** Featured market of the latest round (spec-v2 §10.2). */
export const FEATURED_PROPERTY = Number(process.env.NEXT_PUBLIC_FEATURED_PROPERTY || 1);
