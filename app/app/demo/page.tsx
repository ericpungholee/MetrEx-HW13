"use client";

// Settlement (spec §3.1 item 5, §11.2 step 5): operator view. Close a market, run the oracle,
// then show the perimeter against the trigger circle and verify the evidence.
import { verifyEvidenceText } from "@metrex/geo";
import { marketStatusOf } from "@metrex/shared";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { NetworkPanel } from "@/components/NetworkPanel";
import { PerimeterMap } from "@/components/PerimeterMap";
import {
  Empty,
  ErrorLine,
  PageHeader,
  Panel,
  ReplayLabel,
  scenarioName,
  Stat,
  StatusPill,
  TriggerWording,
  TxLink,
} from "@/components/ui";
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

async function recomputeCanonicalHash(text: string): Promise<string | null> {
  try {
    return verifyEvidenceText(text).hashHex;
  } catch {
    return null;
  }
}

export default function DemoPage() {
  const ex = usePoll(fetchExchange, []);
  const [password, setPassword] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<"close" | "resolve" | null>(null);
  const [result, setResult] = useState<{ action: string; res?: ApiResult; error?: string } | null>(null);

  useEffect(() => {
    try {
      sessionStorage.removeItem("metrex-demo-password");
    } catch {
      // Storage may be disabled.
    }
  }, []);

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
      if (!resolved || !selKey || !sel || isZeroBytes(sel.market.account.evidenceHash)) return null;
      const text = await fetchEvidenceText(selKey);
      if (text === null) return { market: selKey.toBase58(), text: null, fileHash: null, canonicalHash: null };
      return { market: selKey.toBase58(), text, fileHash: await sha256Hex(text), canonicalHash: await recomputeCanonicalHash(text) };
    },
    [resolved, selKey?.toBase58(), sel ? toHex(sel.market.account.evidenceHash) : ""],
    10_000,
  );

  const currentEvidence = evidence.data?.market === selKey?.toBase58() ? evidence.data : undefined;

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
    <div className="animate-in space-y-10">
      <PageHeader
        title="Settlement"
        description="Close a market, replay the oracle against the packaged perimeter, and verify the evidence."
        action={
          <div className="w-full sm:w-64">
            <label className="text-xs font-medium tracking-wide text-faint uppercase">Operator password</label>
            <input
              className="input mt-1.5"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Required to settle"
            />
          </div>
        }
      />

      <NetworkPanel />
      <ErrorLine error={ex.error} />

      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[300px_1fr]">
        <Panel title="Markets">
          {ex.loading && <Empty>Loading…</Empty>}
          {ex.data && summaries.length === 0 && <Empty>No markets.</Empty>}
          <div>
            {summaries.map((s) => {
              const key = s.market.publicKey.toBase58();
              const active = sel?.market.publicKey.toBase58() === key;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedKey(key)}
                  className={`block w-full border-b border-line px-1 py-4 text-left transition-colors last:border-b-0 ${active ? "bg-bg-soft" : "hover:bg-bg-soft/50"}`}
                >
                  <div className="font-semibold tracking-tight">{s.label}</div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <StatusPill state={s.display} />
                    <span className="num text-xs text-faint">
                      {formatMusd(s.activated, 0)} / {formatMusd(s.target, 0)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>

        {sel && selKey ? (
          <div className="space-y-10">
            <section className="space-y-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">{sel.label}</h2>
                <Link className="text-sm text-dim underline-offset-2 hover:text-ink hover:underline" href={`/market/${selKey.toBase58()}`}>
                  Open market
                </Link>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <StatusPill state={sel.display} />
                <ReplayLabel />
              </div>
              <TriggerWording />
              <div className="grid grid-cols-2 gap-5 border-y border-line py-5 sm:grid-cols-5">
                <Stat label="Scenario">{scenarioName(sel.market.account.scenarioId)}</Stat>
                <Stat label="Location">
                  <span className="num text-sm">
                    {formatE6(sel.market.account.latE6)}, {formatE6(sel.market.account.lonE6)}
                  </span>
                </Stat>
                <Stat label="Trigger">{sel.market.account.triggerDistanceM} m</Stat>
                <Stat label="Activated">{formatMusd(sel.activated)}</Stat>
                <Stat label="Positions">{sel.acceptedOffers.length}</Stat>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="btn btn-primary"
                  disabled={busy !== null || status !== "open" || !password || USE_FIXTURES}
                  onClick={() => act("close", selKey)}
                >
                  {busy === "close" ? "Closing…" : "1 · Close market"}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy !== null || (status !== "closed" && !resolved) || !password || USE_FIXTURES}
                  onClick={() => act("resolve", selKey)}
                >
                  {busy === "resolve" ? "Resolving…" : resolved ? "Recover evidence" : "2 · Run oracle"}
                </button>
                {!password && <span className="text-sm text-faint">Enter the operator password to continue.</span>}
              </div>
              {result && (
                <div className={`border px-4 py-3 text-sm ${resErr ? "border-down/30 bg-down-soft text-down" : "border-up/30 bg-up-soft text-up"}`}>
                  <span className="font-medium">{result.action}:</span>{" "}
                  {resErr ? resErr : resSig ? <>confirmed · <TxLink signature={resSig} /></> : "done"}
                </div>
              )}
            </section>

            <Panel title={resolved ? "Settlement map" : "Trigger area"}>
              <PerimeterMap
                height={400}
                settledMarket={resolved && currentEvidence?.text && !USE_FIXTURES ? selKey.toBase58() : undefined}
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

            <Panel title="Evidence">
              {!resolved && <Empty>Evidence appears after the oracle resolves this market.</Empty>}
              {resolved && (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[160px_1fr]">
                    <span className="text-dim">On-chain hash</span>
                    <span className="num break-all text-ink">{onChainHash ?? "—"}</span>
                    <span className="text-dim">File hash</span>
                    <span className="num break-all">
                      {currentEvidence?.fileHash ?? (evidence.loading ? "…" : "Unavailable")}
                      {currentEvidence?.fileHash && onChainHash && (
                        <span className={`ml-2 font-medium ${currentEvidence.fileHash === onChainHash ? "text-up" : "text-down"}`}>
                          {currentEvidence.fileHash === onChainHash ? "Matches" : "Mismatch"}
                        </span>
                      )}
                    </span>
                    <span className="text-dim">Canonical check</span>
                    <span className="num break-all">
                      {currentEvidence?.canonicalHash ? (
                        <>
                          {currentEvidence.canonicalHash}
                          <span className={`ml-2 font-medium ${currentEvidence.canonicalHash === onChainHash ? "text-up" : "text-down"}`}>
                            {currentEvidence.canonicalHash === onChainHash ? "Matches" : "Mismatch"}
                          </span>
                        </>
                      ) : (
                        <span className="text-faint">Not valid evidence JSON</span>
                      )}
                    </span>
                  </div>
                  {currentEvidence?.text && (
                    <pre className="num max-h-72 overflow-auto border border-line bg-bg-soft p-4 text-xs whitespace-pre-wrap">
                      {prettyEvidence(currentEvidence.text)}
                    </pre>
                  )}
                  {USE_FIXTURES && <p className="text-sm text-fixture">Fixture evidence (not produced by the oracle).</p>}
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
