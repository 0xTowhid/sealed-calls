import { useCallback, useEffect, useState } from "react";
import { accountId, wallet } from "./near";
import type { Channel, Signal } from "./types";

/** Runs `fn` now, on `deps` change and every `refreshMs`; keeps the last good value. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], refreshMs = 20_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);
  const run = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load]);
  useEffect(() => {
    run();
    if (!refreshMs) return;
    const t = setInterval(run, refreshMs);
    return () => clearInterval(t);
  }, [run, refreshMs]);
  return { data, error, reload: run };
}

/** `?viewas=<account>` shows the app read-only as that account (for previews and demos); actions still need a wallet. */
const VIEW_AS = new URLSearchParams(window.location.search).get("viewas");

export function useAccount() {
  const [acct, setAcct] = useState<string | null>(VIEW_AS);
  useEffect(() => {
    if (VIEW_AS) return;
    let unsub: (() => void) | undefined;
    wallet()
      .then((s) => {
        accountId().then(setAcct);
        const sub = s.store.observable.subscribe((st) => setAcct(st.accounts.find((a) => a.active)?.accountId ?? null));
        unsub = () => sub.unsubscribe();
      })
      .catch(() => setAcct(null));
    return () => unsub?.();
  }, []);
  return acct;
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** A creator's record from scored signals: same formula as the contract, S = Σr / (n + 5). */
export function record(ch: Channel, signals: Signal[]) {
  const scored = signals.filter((s) => s.r_bps != null);
  const sum = scored.reduce((a, s) => a + (s.r_bps ?? 0), 0);
  const filled = scored.filter((s) => !["not_filled", "invalid", "unrevealed", "no_market", "below_floor", "no_pool_at_post", "no_data", "no_trades"].includes((s.outcome ?? "").split(" ")[0]));
  return {
    signals: signals.length,
    scored: scored.length,
    wins: scored.filter((s) => (s.r_bps ?? 0) > 0).length,
    filled: filled.length,
    notFilled: scored.filter((s) => (s.outcome ?? "").startsWith("not_filled")).length,
    score_bps: scored.length ? Math.trunc(sum / (scored.length + 5)) : null,
    winRate: filled.length ? Math.round((100 * filled.filter((s) => (s.r_bps ?? 0) > 0).length) / filled.length) : null,
    periodsEarned: ch.stats.periods_released,
    periodsSettled: ch.stats.periods_released + ch.stats.periods_refunded,
  };
}
