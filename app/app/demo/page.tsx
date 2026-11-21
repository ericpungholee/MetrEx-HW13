"use client";

// Settlement (spec §3.1 item 5, §11.2 step 5): operator view. Close a market, show the fire
// perimeter against the property's 500 m circle, run the oracle, show and verify the evidence.
import { marketStatusOf } from "@metrex/shared";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { NetworkPanel } from "@/components/NetworkPanel";
import { PerimeterMap } from "@/components/PerimeterMap";
import { Empty, ErrorLine, Panel, ReplayLabel, scenarioName, Stat, StatusPill, TriggerWording, TxLink } from "@/components/ui";
import {
  describeError,
  fetchEvidenceText,
  fetchExchange,
  requestCloseMarket,
  requestResolveMarket,
  USE_FIXTURES,
  type ApiResult,
} from "@/lib/client";
import { summarizeMarket } from "@/lib/derive";
import { formatE6, formatMusd, isZeroBytes, toHex } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

const PASSWORD_KEY = "metrex-demo-password";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/**
 * TODO(integrator, Workstream B): browser-side canonical re-check (spec §8.4).
 * Replace the body with `@metrex/geo`'s canonicalizer once it is exported, e.g.
 *   import { canonicalize } from "@metrex/geo";
 *   return sha256Hex(canonicalize(JSON.parse(text)));
 * Returning null shows "pending @metrex/geo" in the evidence panel.
 */
async function recomputeCanonicalHash(_text: string): Promise<string | null> {
  return null;
}

export default function DemoPage() {
  const ex = usePoll(fetchExchange, []);
  const [password, setPassword] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<"close" | "resolve" | null>(null);
  const [result, setResult] = useState<{ action: string; res?: ApiResult; error?: string } | null>(null);

  useEffect(() => {
    try {
      setPassword(sessionStorage.getItem(PASSWORD_KEY) ?? "");
    } catch {
      /* sessionStorage unavailable */
    }
  }, []);
  function savePassword(v: string) {
    setPassword(v);
    try {
      sessionStorage.setItem(PASSWORD_KEY, v);
    } catch {
      /* ignore */
    }
  }

  const summaries = useMemo(
    () => (ex.data ? ex.data.markets.map((m) => summarizeMarket(m, ex.data!.offers, ex.data!.properties)) : []),
    [ex.data],
  );
  const sel = summaries.find((s) => s.market.publicKey.toBase58() === selectedKey) ?? summaries[0];
  const selKey = sel?.market.publicKey ?? null;
  const status = sel ? marketStatusOf(sel.market.account.status) : null;
  const resolved = status === "resolvedYes" || status === "resolvedNo";

  const evidence = usePoll(
    async () => {
      if (!selKey || !sel || isZeroBytes(sel.market.account.evidenceHash)) return null;
      const text = await fetchEvidenceText(selKey);
      if (text === null) return { text: null, fileHash: null, canonicalHash: null };
      return { text, fileHash: await sha256Hex(text), canonicalHash: await recomputeCanonicalHash(text) };
    },
    [selKey?.toBase58(), sel ? toHex(sel.market.account.evidenceHash) : ""],
    10_000,
  );

  async function act(kind: "close" | "resolve", market: PublicKey) {
    setBusy(kind);
    setResult(null);
    try {
      const res = kind === "close" ? await requestCloseMarket(market, password) : await requestResolveMarket(market, password);
      setResult({ action: kind === "close" ? "Close market" : "Run oracle", res });
      ex.refresh();
    } catch (e) {
      setResult({ action: kind === "close" ? "Close market" : "Run oracle", error: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  const onChainHash = sel && !isZeroBytes(sel.market.account.evidenceHash) ? toHex(sel.market.account.evidenceHash) : null;
  const resSig = typeof result?.res?.body?.signature === "string" ? (result.res.body.signature as string) : null;
  const resErr =
    result?.error ??
    (result?.res && !result.res.ok
      ? typeof result.res.body?.error === "string"
        ? (result.res.body.error as string)
        : `HTTP ${result.res.status}${result.res.status === 404 ? " (endpoint not available yet)" : ""}`
      : null);

  return (
    <div className="space-y-4">
      <NetworkPanel />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Settlement · operator</h1>
          <p className="text-xs text-dim">Close a market, replay the oracle against the packaged perimeter, verify the evidence.</p>
        </div>
        <div className="w-72">
          <label className="text-[11px] text-dim">Demo password (kept in this tab&apos;s session only)</label>
          <input className="input mt-1" type="password" value={password} onChange={(e) => savePassword(e.target.value)} />
        </div>
      </div>
      <ErrorLine error={ex.error} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
        <Panel title="Markets">
          {ex.loading && <Empty>Loading…</Empty>}
          {ex.data && summaries.length === 0 && <Empty>No markets.</Empty>}
          <div className="space-y-1">
            {summaries.map((s) => {
              const key = s.market.publicKey.toBase58();
              const active = sel?.market.publicKey.toBase58() === key;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedKey(key)}
                  className={`block w-full rounded border px-3 py-2 text-left ${active ? "border-info bg-info/10" : "border-line hover:border-dim"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{s.label}</span>
                    <StatusPill state={s.display} />
                  </div>
                  <div className="num text-[11px] text-dim">
                    {formatMusd(s.activated, 0)} / {formatMusd(s.target, 0)} mUSD · {key.slice(0, 8)}…
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>

        {sel && selKey ? (
          <div className="space-y-4">
            <Panel
              title={sel.label}
              right={
                <Link className="text-xs text-info hover:underline" href={`/market/${selKey.toBase58()}`}>
                  open market →
                </Link>
              }
            >
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill state={sel.display} />
                <ReplayLabel />
              </div>
              <div className="mt-2">
                <TriggerWording />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label="Scenario">{scenarioName(sel.market.account.scenarioId)}</Stat>
                <Stat label="Point (approx.)">
                  {formatE6(sel.market.account.latE6)}, {formatE6(sel.market.account.lonE6)}
                </Stat>
                <Stat label="Trigger">{sel.market.account.triggerDistanceM} m</Stat>
                <Stat label="Activated">{formatMusd(sel.activated)}</Stat>
                <Stat label="Positions">{sel.acceptedOffers.length}</Stat>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-primary"
                  disabled={busy !== null || status !== "open" || !password || USE_FIXTURES}
                  onClick={() => act("close", selKey)}
                >
                  {busy === "close" ? "Closing…" : "1 · Close market"}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy !== null || status !== "closed" || !password || USE_FIXTURES}
                  onClick={() => act("resolve", selKey)}
                >
                  {busy === "resolve" ? "Resolving…" : "2 · Run oracle"}
                </button>
                {!password && <span className="text-[11px] text-faint">Enter the demo password to enable.</span>}
                {USE_FIXTURES && <span className="text-[11px] text-fixture">Fixture mode: transactions disabled</span>}
              </div>
              {result && (
                <div className={`mt-3 rounded border px-3 py-2 text-xs ${resErr ? "border-down/50 text-down" : "border-up/50 text-up"}`}>
                  <span className="font-semibold">{result.action}:</span>{" "}
                  {resErr ? resErr : resSig ? <>confirmed <TxLink signature={resSig} /></> : "done"}
                </div>
              )}
            </Panel>

            <Panel title="Perimeter vs trigger circle">
              <PerimeterMap
                height={420}
                points={[
                  {
                    key: selKey.toBase58(),
                    lat: sel.market.account.latE6 / 1e6,
                    lon: sel.market.account.lonE6 / 1e6,
                    label: sel.label,
                    radiusM: sel.market.account.triggerDistanceM,
                    selected: true,
                  },
                ]}
              />
            </Panel>

            <Panel title="Evidence record">
              {!resolved && <Empty>The evidence record appears once the oracle resolves this market.</Empty>}
              {resolved && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[180px_1fr]">
                    <span className="text-dim">On-chain evidence_hash</span>
                    <span className="num break-all">{onChainHash ?? "—"}</span>
                    <span className="text-dim">SHA-256 of served file</span>
                    <span className="num break-all">
                      {evidence.data?.fileHash ?? (evidence.loading ? "…" : "evidence file unavailable")}
                      {evidence.data?.fileHash && onChainHash && (
                        <span className={`ml-2 font-bold ${evidence.data.fileHash === onChainHash ? "text-up" : "text-down"}`}>
                          {evidence.data.fileHash === onChainHash ? "✓ matches on-chain" : "✗ does not match"}
                        </span>
                      )}
                    </span>
                    <span className="text-dim">Canonical re-check</span>
                    <span className="num break-all">
                      {evidence.data?.canonicalHash ? (
                        <>
                          {evidence.data.canonicalHash}
                          <span className={`ml-2 font-bold ${evidence.data.canonicalHash === onChainHash ? "text-up" : "text-down"}`}>
                            {evidence.data.canonicalHash === onChainHash ? "✓" : "✗"}
                          </span>
                        </>
                      ) : (
                        <span className="text-faint">pending @metrex/geo canonicalizer (TODO hook)</span>
                      )}
                    </span>
                  </div>
                  {evidence.data?.text && (
                    <pre className="num max-h-72 overflow-auto rounded border border-line bg-bg p-3 text-[11px] whitespace-pre-wrap">
                      {prettyEvidence(evidence.data.text)}
                    </pre>
                  )}
                  {USE_FIXTURES && <p className="text-[11px] text-fixture">FIXTURE evidence record (not produced by the oracle).</p>}
                </div>
              )}
            </Panel>
          </div>
        ) : (
          !ex.loading && <Empty>Select a market.</Empty>
        )}
      </div>
    </div>
  );
}

function prettyEvidence(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
