"use client";

// Market-page Settle market and Reset market (docs/spec-simulation.md §7.1), side by side under
// the trade ticket. Neither has logic of its own; both call the existing /api/operator endpoints:
// - Settle runs the §7 fast-forward scoped to this market (POST /api/operator/settle-round). The
//   server refuses unless the market is its round's only member, so no other market is touched.
// - Reset runs the §9 Reset Market operation (POST /api/operator/demo): the oracle settles the round
//   (history and every claim stay redeemable), then a fresh round opens for the same property.
//   Human wallets and the other markets are never touched. When it completes the page moves to the
//   new market.
// The buttons advance the lifecycle only; the oracle decides every outcome from the committed dataset.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { demoAction, fetchDemoStatus, operatorStep, USE_FIXTURES, type MarketInfo } from "@/lib/exchange-client";

type Body = Record<string, unknown>;
type Result = { ok: boolean; text: string; links: { label: string; href: string }[] };

const RESET_TIMEOUT_MS = 5 * 60_000;

function summarize(body: Body, market: string): Result {
  const steps = (body.steps as Body[] | undefined) ?? [];
  const st = body.status as Body | null | undefined;
  const mine = ((st?.markets as Body[] | undefined) ?? []).find((m) => m.address === market);
  const outcome = mine ? String(mine.outcome) : "unresolved";
  const word = outcome === "yes" ? "YES" : outcome === "no" ? "NO" : outcome === "invalid" ? "Invalid" : null;
  return {
    ok: word !== null,
    text: word ? `Oracle resolved ${word}. Winning shares are redeemable in Position.` : "Settlement submitted. Waiting for the oracle result.",
    links: steps
      .filter((s) => typeof s.explorer === "string")
      .map((s) => ({ label: `${String(s.step)} tx`, href: String(s.explorer) })),
  };
}

export function MarketControls({ info, onSettled }: { info: MarketInfo; onSettled: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"settle" | "reset" | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const m = info.market;
  const r = info.round;
  const resolved = m.outcome !== "unresolved";
  const shared = r.marketCount !== 1;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  if (USE_FIXTURES) return null;

  async function settle() {
    if (inFlight.current || resolved || shared) return;
    if (!window.confirm("Settle this market now?\n\nTrading closes on this market only, and the oracle resolves it from the dataset committed on-chain. Winning shares become redeemable. This cannot be undone.")) return;
    inFlight.current = true;
    setBusy("settle");
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      const res = await operatorStep("fast_forward", r.address, m.address);
      if (!res.ok) setError(String(res.body.error ?? `Settlement failed (${res.status})`));
      else setResult(summarize(res.body, m.address));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(null);
      onSettled();
    }
  }

  async function reset() {
    if (inFlight.current) return;
    if (!window.confirm(
      `Reset this market?\n\n${resolved ? "" : "Trading closes and the oracle settles this round first. "}This market is then removed from the portfolio, along with any shares or unredeemed winnings in it. A fresh market opens for the same property with a new trading period, maker liquidity and simulated traders.\n\nWallet mUSD balances and the other three markets are not touched. You will be taken to the new market.`,
    )) return;
    inFlight.current = true;
    setBusy("reset");
    setError(null);
    setResult(null);
    setProgress("Starting reset…");
    try {
      // A reset of this market that stopped part-way resumes from its journaled phase.
      const prev = (await fetchDemoStatus().catch(() => null))?.operation;
      const resume = !!prev && !prev.completed && !prev.running && prev.action === "reset_market" && prev.rounds[0] === r.address;
      const res = resume ? await demoAction("resume_operation") : await demoAction("reset_market", r.address);
      if (!res.ok) {
        setError(String(res.body.error ?? `Reset failed (${res.status})`));
        return;
      }
      const opId = String((res.body.operation as Body | undefined)?.id ?? "");
      const deadline = Date.now() + RESET_TIMEOUT_MS;
      while (alive.current && Date.now() < deadline) {
        await new Promise((ok) => setTimeout(ok, 2_000));
        const st = await fetchDemoStatus().catch(() => null);
        const op = st?.operation;
        if (!st || !op || op.id !== opId) continue;
        const last = op.log[op.log.length - 1]?.text;
        if (last) setProgress(last);
        if (op.failed) {
          setError(`Reset stopped: ${op.error ?? "unknown error"}. Press Reset market to resume.`);
          return;
        }
        if (op.completed) {
          const next = op.replacements[r.address];
          if (!next) {
            setError("Reset finished without a new market.");
            return;
          }
          // The fresh market should have active simulated traders.
          if (st.simulationPaused) await demoAction("resume_sim").catch(() => null);
          setProgress("Opening the new market…");
          router.push(`/market/${next}`);
          return;
        }
      }
      if (alive.current) setError("Reset is still running. Reload this page in a minute.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
      onSettled();
    }
  }

  return (
    <div aria-label="Market lifecycle">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null || resolved || shared}
          aria-busy={busy === "settle"}
          title={shared ? `This round has ${r.marketCount} markets, so it cannot be settled one market at a time.` : undefined}
          onClick={settle}
        >
          {busy === "settle" ? "Settling…" : resolved ? "Settled" : "Settle market"}
        </button>
        <button type="button" className="btn" disabled={busy !== null} aria-busy={busy === "reset"} onClick={reset}>
          {busy === "reset" ? "Resetting…" : "Reset market"}
        </button>
      </div>
      {busy && (
        <p aria-live="polite" className="mt-2 text-xs text-dim">
          {busy === "settle" ? "Trading stops within seconds. Finalizing, publishing evidence and sweeping orders takes up to a minute." : progress}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-down">{error}</p>}
      {result && (
        <div aria-live="polite" className="mt-2 text-xs">
          <p className={result.ok ? "text-ink-secondary" : "text-warn"}>{result.text}</p>
          {result.links.map((l) => (
            <a key={l.href} className="mr-3 text-info hover:underline" href={l.href} target="_blank" rel="noreferrer">
              {l.label} on Explorer
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
