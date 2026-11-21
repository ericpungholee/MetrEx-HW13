"use client";

// Create (spec §3.1 item 2): choose a registered property, enter coverage. That's the whole form.
import { decodeLabel, MAX_COVERAGE_TARGET, MIN_COVERAGE } from "@metrex/shared";
import { useWalletSigner } from "@/lib/useWalletSigner";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PerimeterMap } from "@/components/PerimeterMap";
import { useTx } from "@/components/TxProvider";
import { Empty, ErrorLine, Panel, ReplayLabel, scenarioName, TriggerWording } from "@/components/ui";
import { createMarket, fetchProperties, requireSigner, USE_FIXTURES } from "@/lib/client";
import { formatE6, formatMusd, parseMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

export default function CreatePage() {
  const props = usePoll(fetchProperties, [], 15_000);
  const wallet = useWalletSigner();
  const { setVisible } = useWalletModal();
  const { run } = useTx();
  const router = useRouter();
  const [selected, setSelected] = useState<number | null>(null);
  const [coverageText, setCoverageText] = useState("10000");
  const [busy, setBusy] = useState(false);

  const list = props.data ?? [];
  const sel = list.find((p) => p.account.propertyId === selected) ?? list[0];
  const coverage = parseMusd(coverageText);
  const coverageError =
    coverage === null
      ? "Enter an amount in mUSD"
      : coverage < MIN_COVERAGE
        ? `Minimum is ${formatMusd(MIN_COVERAGE, 0)} mUSD`
        : coverage > MAX_COVERAGE_TARGET
          ? `Maximum is ${formatMusd(MAX_COVERAGE_TARGET, 0)} mUSD`
          : null;

  const points = useMemo(
    () =>
      list.map((p) => ({
        key: String(p.account.propertyId),
        lat: p.account.latE6 / 1e6,
        lon: p.account.lonE6 / 1e6,
        label: decodeLabel(p.account.label),
        radiusM: p.account.triggerDistanceM,
        selected: sel ? p.account.propertyId === sel.account.propertyId : false,
      })),
    [list, sel],
  );

  async function submit() {
    if (!sel || coverage === null || coverageError) return;
    if (!wallet && !USE_FIXTURES) {
      setVisible(true);
      return;
    }
    setBusy(true);
    let marketKey: string | null = null;
    const res = await run(`Create market · ${decodeLabel(sel.account.label)}`, async (opts) => {
      const r = await createMarket(requireSigner(wallet), sel.account.propertyId, coverage, opts);
      marketKey = r.market.toBase58();
      return r.results;
    });
    setBusy(false);
    if (res && marketKey) router.push(`/market/${marketKey}`);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-lg font-bold">Create a market</h1>
        <p className="text-xs text-dim">Create a wildfire replay market at a registered point. Any wallet can participate, and property ownership is unverified.</p>
      </div>
      <ErrorLine error={props.error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.1fr]">
        <Panel title="1 · Registered property">
          {props.loading && <Empty>Loading registered properties…</Empty>}
          {props.data && list.length === 0 && <Empty>No properties are registered on this cluster yet.</Empty>}
          <div className="space-y-1">
            {list.map((p) => {
              const active = sel?.account.propertyId === p.account.propertyId;
              return (
                <label
                  key={p.publicKey.toBase58()}
                  className={`flex cursor-pointer items-center gap-3 rounded border px-3 py-2 ${active ? "border-info bg-info/10" : "border-line hover:border-dim"}`}
                >
                  <input
                    type="radio"
                    name="property"
                    checked={active}
                    onChange={() => setSelected(p.account.propertyId)}
                    className="accent-[#4ea1ff]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{decodeLabel(p.account.label)}</div>
                    <div className="num text-[11px] text-dim">
                      #{p.account.propertyId} · {scenarioName(p.account.scenarioId)} · trigger {p.account.triggerDistanceM} m ·{" "}
                      {formatE6(p.account.latE6)}, {formatE6(p.account.lonE6)} (approx.)
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="mt-3">
            <PerimeterMap points={points} height={260} onSelect={(k) => setSelected(Number(k))} />
          </div>
        </Panel>
        <Panel title="2 · Coverage">
          <label className="block text-xs text-dim">Coverage requested (mUSD)</label>
          <input
            className="input mt-1 text-lg"
            inputMode="decimal"
            value={coverageText}
            onChange={(e) => setCoverageText(e.target.value)}
          />
          <div className="mt-1 h-4 text-[11px] text-down">{coverageError}</div>
          {coverage !== null && !coverageError && (
            <div className="num mt-1 text-xs text-dim">= {coverage.toString()} base units</div>
          )}
          <div className="mt-4 space-y-2 rounded border border-line bg-bg p-3">
            <ReplayLabel />
            <TriggerWording />
            <p className="text-[11px] text-faint">
              Coordinates are copied on-chain from the registered property; the oracle evaluates exactly those.
            </p>
          </div>
          <button
            className="btn btn-primary mt-4 w-full justify-center py-2 text-sm"
            disabled={busy || !sel || !!coverageError}
            onClick={submit}
          >
            {busy ? "Creating…" : wallet || USE_FIXTURES ? "Create market (1 signature)" : "Connect wallet"}
          </button>
          {USE_FIXTURES && <p className="mt-2 text-center text-[11px] text-fixture">Fixture mode: transactions disabled</p>}
        </Panel>
      </div>
    </div>
  );
}
