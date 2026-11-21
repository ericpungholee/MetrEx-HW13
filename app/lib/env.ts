// Public runtime configuration. Switching to Devnet (or a new deploy) is env-only.
// NEXT_PUBLIC_* must be referenced literally so Next.js inlines them at build time.
export const USE_FIXTURES = process.env.NEXT_PUBLIC_USE_FIXTURES === "1";

/**
 * The browser's RPC endpoint. Defaults to this app's own /api/rpc proxy, which forwards an
 * allowlist of methods to the server's RPC_URL so a provider key never reaches the browser.
 * NEXT_PUBLIC_RPC_URL overrides it (only ever with a key-free URL). The public Devnet endpoint is
 * used only during server rendering, where nothing is fetched.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || (typeof window !== "undefined" ? `${window.location.origin}/api/rpc` : "https://api.devnet.solana.com");

export const POLL_MS = 3_000;
