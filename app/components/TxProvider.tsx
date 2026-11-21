"use client";

// Transaction status (spec §10.1): pending → confirmed → Explorer link, or a readable error.
// Only real confirmed signatures are ever shown as confirmed.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import {
  describeError,
  FixtureModeError,
  PartialBatchError,
  type TxProgress,
  type TxResult,
  type WriteOptions,
} from "@/lib/client";
import { shortKey } from "@/lib/format";

type Stage = "pending" | "confirmed" | "error" | "disabled";

interface TxToast {
  id: number;
  label: string;
  stage: Stage;
  detail: string;
  results: TxResult[];
  error?: string;
}

interface TxContextValue {
  /** Run a write. Resolves to its results, or null on failure (the toast shows why). */
  run: (label: string, fn: (opts: WriteOptions) => Promise<TxResult[]>) => Promise<TxResult[] | null>;
}

const TxContext = createContext<TxContextValue | null>(null);

export function useTx(): TxContextValue {
  const ctx = useContext(TxContext);
  if (!ctx) throw new Error("useTx must be used inside <TxProvider>");
  return ctx;
}

function progressText(p: TxProgress): string {
  switch (p.stage) {
    case "building":
      return "Building transaction…";
    case "signing":
      return p.total > 1 ? `Approve ${p.total} transactions in your wallet…` : "Approve in your wallet…";
    case "sending":
      return p.total > 1 ? `Sending ${p.index + 1}/${p.total}, waiting for confirmation…` : "Sent, waiting for confirmation…";
    case "confirmed":
      return p.total > 1 ? `Confirmed ${p.index + 1}/${p.total}` : "Confirmed";
  }
}

let nextId = 1;

export function TxProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<TxToast[]>([]);

  const update = useCallback((id: number, patch: Partial<TxToast>) => {
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const run = useCallback<TxContextValue["run"]>(
    async (label, fn) => {
      const id = nextId++;
      setToasts((ts) => [...ts.slice(-4), { id, label, stage: "pending", detail: "Preparing…", results: [] }]);
      const collected: TxResult[] = [];
      try {
        const results = await fn({
          onProgress: (p) => {
            if (p.stage === "confirmed") collected.push(p.result);
            update(id, { detail: progressText(p), results: [...collected] });
          },
        });
        update(id, { stage: "confirmed", detail: "Confirmed", results });
        return results;
      } catch (e) {
        if (e instanceof FixtureModeError) {
          update(id, { stage: "disabled", detail: e.message, error: e.message });
        } else if (e instanceof PartialBatchError) {
          update(id, { stage: "error", detail: "Partially confirmed", results: e.confirmed, error: describeError(e.cause) });
        } else {
          update(id, { stage: "error", detail: "Failed", results: [...collected], error: describeError(e) });
        }
        return null;
      }
    },
    [update],
  );

  return (
    <TxContext.Provider value={{ run }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[1000] flex w-[380px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded border bg-panel p-3 shadow-lg ${
              t.stage === "confirmed"
                ? "border-up/60"
                : t.stage === "error"
                  ? "border-down/60"
                  : t.stage === "disabled"
                    ? "border-fixture/60"
                    : "border-info/60"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="font-semibold">{t.label}</div>
              <button className="text-dim hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                ×
              </button>
            </div>
            <div
              className={`mt-1 text-xs ${
                t.stage === "confirmed" ? "text-up" : t.stage === "error" ? "text-down" : t.stage === "disabled" ? "text-fixture" : "text-info"
              }`}
            >
              {t.stage === "pending" && <span className="mr-1 inline-block animate-pulse">●</span>}
              {t.detail}
            </div>
            {t.error && t.stage === "error" && <div className="mt-1 text-xs text-ink">{t.error}</div>}
            {t.results.map((r) => (
              <div key={r.signature} className="num mt-1 flex justify-between text-xs">
                <a className="text-info hover:underline" href={r.explorerUrl} target="_blank" rel="noreferrer">
                  {shortKey(r.signature, 8)} ↗
                </a>
                <span className="text-dim">{(r.latencyMs / 1000).toFixed(2)} s</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </TxContext.Provider>
  );
}
