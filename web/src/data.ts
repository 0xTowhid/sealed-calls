import { useCallback, useEffect, useState } from "react";
import { CLUB, GECKO } from "./config";
import { allCalls, currentEpoch, getClub, getEpoch, accountId, wallet } from "./near";
import { rememberName } from "./format";
import type { Call, Club, EpochResult } from "./types";
import { revealedMint } from "./types";

export type ClubData = {
  club: Club;
  calls: Call[];
  epoch: number;
  epochs: Map<number, EpochResult>;
};

export function useClubData(refreshMs = 20_000) {
  const [data, setData] = useState<ClubData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setNames] = useState(0);

  const load = useCallback(async () => {
    try {
      const club = await getClub(CLUB);
      if (!club) throw new Error(`Club ${CLUB} doesn't exist on this contract yet.`);
      const [calls, epoch] = await Promise.all([allCalls(CLUB, club.call_count), currentEpoch(CLUB)]);
      const epochs = new Map<number, EpochResult>();
      await Promise.all(
        Array.from({ length: epoch + 1 }, (_, e) => getEpoch(CLUB, e).then((r) => { if (r) epochs.set(e, r); })),
      );
      setData({ club, calls, epoch, epochs });
      setError(null);
      // Tickers for revealed tokens (display only; a failed lookup shows the short address).
      const mints = [...new Set(calls.map(revealedMint).filter((m): m is string => !!m))];
      for (const m of mints) {
        fetch(`${GECKO}/tokens/${m}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { const s = j?.data?.attributes?.symbol; if (s) { rememberName(m, s); setNames((n) => n + 1); } })
          .catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  return { data, error, reload: load };
}

export function useAccount() {
  const [acct, setAcct] = useState<string | null>(null);
  useEffect(() => {
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

/** Same aggregation as the contract: S = Σr / (n + 5). Unscored resolved calls count as −100%. */
export function record(calls: Call[]) {
  const done = calls.filter((c) => c.score_bps != null);
  const sum = done.reduce((s, c) => s + (c.score_bps ?? 0), 0);
  return {
    total: calls.length,
    scored: done.length,
    positive: done.filter((c) => (c.score_bps ?? 0) > 0).length,
    score_bps: done.length ? Math.trunc(sum / (done.length + 5)) : null,
  };
}
