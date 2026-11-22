"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./transactions";
import { POLL_MS } from "./env";

export interface Poll<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Poll `fn` every `intervalMs` (default 3 s, spec §10.1). Restarts when `deps` change. */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = POLL_MS): Poll<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const d = await fnRef.current();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(describeError(e));
      } finally {
        if (alive) timer = setTimeout(run, intervalMs);
      }
    };
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, intervalMs]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading: data === undefined && error === null, refresh };
}
