"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { MUSD_UNIT } from "@metrex/shared";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { fetchMusdBalance, fetchSolLamports, requestFaucet, describeError, USE_FIXTURES, viewerFor } from "@/lib/client";
import { formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-10 w-36 animate-pulse bg-bg-muted" /> },
);

const NAV = [
  { href: "/", label: "Markets" },
  { href: "/create", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/demo", label: "Settlement" },
];

const LOW_SOL_LAMPORTS = 10_000_000n;
const LOW_MUSD = 100n * MUSD_UNIT;

export function Header() {
  const pathname = usePathname();
  const { publicKey } = useWallet();
  const viewer = viewerFor(publicKey);
  const balances = usePoll(
    async () => {
      if (!viewer) return null;
      const [musd, sol] = await Promise.all([fetchMusdBalance(viewer), fetchSolLamports(viewer)]);
      return { musd, sol };
    },
    [viewer?.toBase58()],
  );
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const low = balances.data && (balances.data.sol < LOW_SOL_LAMPORTS || balances.data.musd < LOW_MUSD);

  async function getFunds() {
    if (!publicKey) return;
    setFaucetBusy(true);
    setFaucetMsg(null);
    try {
      const r = await requestFaucet(publicKey);
      const err = typeof r.body?.error === "string" ? r.body.error : null;
      setFaucetMsg(r.ok ? "Funds requested. Balance updates shortly." : (err ?? `Faucet unavailable (HTTP ${r.status})`));
      balances.refresh();
    } catch (e) {
      setFaucetMsg(describeError(e));
    } finally {
      setFaucetBusy(false);
    }
  }

  return (
    <header className="sticky top-0 z-[900] border-b border-line bg-bg/90 backdrop-blur-md">
      {USE_FIXTURES && (
        <div className="bg-fixture px-4 py-2 text-center text-sm font-medium text-white">
          Fixture mode — offline sample data. Transactions are disabled.
        </div>
      )}
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3.5 sm:px-8">
        <Link href="/" className="shrink-0 text-xl font-semibold tracking-tight text-ink">
          MetrEx
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 py-1.5 text-sm transition-colors ${active ? "font-medium text-ink" : "text-dim hover:text-ink"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          {viewer && balances.data && (
            <div className="hidden text-right sm:block">
              <div className="num text-sm font-medium">
                {formatMusd(balances.data.musd)} <span className="font-normal text-faint">mUSD</span>
              </div>
            </div>
          )}
          {publicKey && low && !USE_FIXTURES && (
            <button className="btn btn-sm hidden sm:inline-flex" disabled={faucetBusy} onClick={getFunds}>
              {faucetBusy ? "Requesting…" : "Get funds"}
            </button>
          )}
          <WalletMultiButton />
          <div className="md:hidden">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Menu"
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? "Close" : "Menu"}
            </button>
          </div>
        </div>
      </div>

      {menuOpen && (
        <nav className="border-t border-line px-5 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {NAV.map((n) => {
              const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setMenuOpen(false)}
                  className={`px-2 py-2.5 text-base ${active ? "font-medium text-ink" : "text-dim"}`}
                >
                  {n.label}
                </Link>
              );
            })}
            {publicKey && low && !USE_FIXTURES && (
              <button className="btn mt-2 w-full" disabled={faucetBusy} onClick={getFunds}>
                {faucetBusy ? "Requesting…" : "Get funds"}
              </button>
            )}
          </div>
        </nav>
      )}

      {faucetMsg && (
        <div className="border-t border-line bg-bg-soft px-5 py-2 text-right text-sm text-dim sm:px-8">
          {faucetMsg}{" "}
          <button className="ml-2 text-faint hover:text-ink" onClick={() => setFaucetMsg(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}
    </header>
  );
}
