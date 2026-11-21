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

// The wallet button reads browser-only wallet state; render it on the client only.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-8 w-36 rounded border border-line bg-panel2" /> },
);

const NAV = [
  { href: "/", label: "Exchange" },
  { href: "/create", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/demo", label: "Settlement" },
];

/** Low-balance thresholds for showing "Get demo funds" (spec §9.3). */
const LOW_SOL_LAMPORTS = 10_000_000n; // 0.01 SOL
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

  const low = balances.data && (balances.data.sol < LOW_SOL_LAMPORTS || balances.data.musd < LOW_MUSD);

  async function getFunds() {
    if (!publicKey) return;
    setFaucetBusy(true);
    setFaucetMsg(null);
    try {
      const r = await requestFaucet(publicKey);
      const err = typeof r.body?.error === "string" ? r.body.error : null;
      setFaucetMsg(r.ok ? "Demo funds requested. Balance updates within seconds." : (err ?? `Faucet unavailable (HTTP ${r.status})`));
      balances.refresh();
    } catch (e) {
      setFaucetMsg(describeError(e));
    } finally {
      setFaucetBusy(false);
    }
  }

  return (
    <header className="sticky top-0 z-[900] border-b border-line bg-bg/95 backdrop-blur">
      {USE_FIXTURES && (
        <div className="bg-fixture px-4 py-1 text-center text-xs font-bold tracking-wider text-black">
          FIXTURE DATA — not on-chain. Transactions are disabled. (NEXT_PUBLIC_USE_FIXTURES=1, dev only)
        </div>
      )}
      <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-4 py-2">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-base font-black tracking-tight">
            Metr<span className="text-up">Ex</span>
          </span>
          <span className="text-[10px] text-faint uppercase">devnet</span>
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded px-3 py-1.5 text-xs font-semibold ${active ? "bg-panel2 text-ink" : "text-dim hover:text-ink"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {viewer && balances.data && (
            <div className="text-right">
              <div className="num text-xs">
                {formatMusd(balances.data.musd)} <span className="text-faint">mUSD</span>
              </div>
              <div className="num text-[10px] text-faint">
                {USE_FIXTURES && !publicKey ? "fixture wallet" : `${(Number(balances.data.sol) / 1e9).toFixed(3)} SOL`}
              </div>
            </div>
          )}
          {publicKey && low && !USE_FIXTURES && (
            <button className="btn btn-up" disabled={faucetBusy} onClick={getFunds}>
              {faucetBusy ? "Requesting…" : "Get demo funds"}
            </button>
          )}
          <WalletMultiButton />
        </div>
      </div>
      {faucetMsg && (
        <div className="mx-auto max-w-[1400px] px-4 pb-2 text-right text-xs text-dim">
          {faucetMsg}{" "}
          <button className="text-faint hover:text-ink" onClick={() => setFaucetMsg(null)}>
            ×
          </button>
        </div>
      )}
    </header>
  );
}
