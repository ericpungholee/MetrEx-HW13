"use client";

// Transaction status (spec §10.1): pending → confirmed → Explorer link, or a readable error.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import {
  describeError,
  FixtureModeError,
  PartialBatchError,
  type TxProgress,
  type TxResult,
  type WriteOptions,
} from "@/lib/transactions";
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
      return "Preparing…";
    case "signing":
      return p.total > 1 ? `Approve ${p.total} transactions in your wallet…` : "Approve in your wallet…";
    case "sending":
      return p.total > 1 ? `Confirming ${p.index + 1} of ${p.total}…` : "Confirming…";
    case "confirmed":
      return p.total > 1 ? `Confirmed ${p.index + 1} of ${p.total}` : "Confirmed";
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
      <div className="fixed right-4 bottom-4 z-[1000] flex w-[min(100vw-2rem,360px)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-in border bg-bg px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.08)] ${
              t.stage === "confirmed"
                ? "border-up/40"
                : t.stage === "error"
                  ? "border-down/40"
                  : t.stage === "disabled"
                    ? "border-fixture/40"
                    : "border-line-strong"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium text-ink">{t.label}</div>
              <button className="text-faint hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                ×
              </button>
            </div>
            <div
              className={`mt-1 text-sm ${
                t.stage === "confirmed"
                  ? "text-up"
                  : t.stage === "error"
                    ? "text-down"
                    : t.stage === "disabled"
                      ? "text-fixture"
                      : "text-dim"
              }`}
            >
              {t.stage === "pending" && <span className="pulse-dot mr-1.5 inline-block text-[10px]">●</span>}
              {t.detail}
            </div>
            {t.error && t.stage === "error" && <div className="mt-1 text-sm text-ink-secondary">{t.error}</div>}
            {t.results.map((r) => (
              <div key={r.signature} className="mt-2 flex justify-between text-sm">
                <a className="num text-ink-secondary underline-offset-2 hover:text-ink hover:underline" href={r.explorerUrl} target="_blank" rel="noreferrer">
                  View on Explorer
                </a>
                <span className="num text-faint">{(r.latencyMs / 1000).toFixed(2)}s</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </TxContext.Provider>
  );
}
