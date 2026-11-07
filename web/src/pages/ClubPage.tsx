import { useState } from "react";
import type { ClubData } from "../data";
import { record, useNow } from "../data";
import { Ledger } from "../Ledger";
import { near, pct, until } from "../format";
import { call as tx } from "../near";
import { NEAR } from "../config";
import { isSealed } from "../types";

export function ClubPage({ data, account, reload }: { data: ClubData; account: string | null; reload: () => void }) {
  const { club, calls, epoch, epochs } = data;
  const now = useNow(1000);
  const epochMs = club.config.epoch_minutes * 60_000;
  const epochEnds = club.started_at_ms + (epoch + 1) * epochMs;
  const paidTo = (caller: string) =>
    [...epochs.values()].reduce((s, e) => s + BigInt(e.callers.find((r) => r.caller === caller)?.paid ?? "0"), 0n);

  return (
    <>
      <section className="sheet">
        <h1>{club.config.name}</h1>
        <p className="sub">Members pay into the club. Callers are paid from it only when their record is positive.</p>
        <dl className="kv">
          <dt>Escrow</dt><dd>{near(club.escrow)} (budget {near(club.config.epoch_budget)} per epoch)</dd>
          <dt>Epoch</dt><dd>{epoch}, ends in {until(epochEnds, now)}</dd>
          <dt>Governed by</dt><dd>{club.governor}</dd>
          <dt>Members</dt><dd>{club.members.length} ({club.members.filter((m) => m.pubkey).length} with keys)</dd>
          <dt>Rules</dt><dd>Horizons {club.config.horizons_min.map((h) => (h % 60 ? `${h}m` : `${h / 60}h`)).join(", ")}; {club.config.max_calls_per_day} calls a day; paid after {club.config.min_record} scored {club.config.min_record === 1 ? "call" : "calls"}</dd>
        </dl>
      </section>

      <section className="sheet">
        <h2>Callers</h2>
        <div className="ledger-wrap">
          <table>
            <thead><tr><th>Caller</th><th className="n">Calls</th><th className="n">Positive</th><th className="n">Score</th><th className="n">Paid</th></tr></thead>
            <tbody>
              {club.callers.map((c) => {
                const r = record(calls.filter((x) => x.caller === c));
                return (
                  <tr key={c}>
                    <td><a href={`#/caller/${c}`}>{c}</a></td>
                    <td className="n">{r.total}</td>
                    <td className="n">{r.positive} / {r.scored}</td>
                    <td className={`n res ${(r.score_bps ?? 0) > 0 ? "gain" : ""}`}>{pct(r.score_bps)}</td>
                    <td className="n">{near(paidTo(c))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fine">Score is the club's pay formula: the sum of net results divided by (calls + 5), so short lucky records rank low.</p>
      </section>

      <Settle data={data} account={account} reload={reload} now={now} />

      <section className="sheet">
        <h2>Every call</h2>
        <p className="sub">Sealed calls show when they open. After that anyone can reveal them.</p>
        <Ledger calls={calls} club={club} account={account} showCaller reload={reload} />
      </section>
    </>
  );
}

function Settle({ data, account, reload, now }: { data: ClubData; account: string | null; reload: () => void; now: number }) {
  const { club, calls, epoch, epochs } = data;
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const epochMs = club.config.epoch_minutes * 60_000;
  const open = Array.from({ length: epoch }, (_, e) => e).filter((e) => epochs.get(e)?.status !== "Settled" && calls.some((c) => c.epoch === e));
  const settled = [...epochs.entries()].filter(([, r]) => r.status === "Settled").sort((a, b) => b[0] - a[0]);
  if (!open.length && !settled.length) return null;

  async function settle(e: number) {
    setMsg(null); setBusy(e);
    try {
      await tx("settle", { club: club.id, epoch: e }, NEAR(0.5));
      setMsg(`Settlement for epoch ${e} sent. OutLayer scores it in about a minute.`);
      setTimeout(reload, 5000);
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }

  return (
    <section className="sheet">
      <h2>Settlement</h2>
      <p className="sub">When an epoch ends and every call in it is open, anyone can settle it. Scoring runs in an OutLayer TEE; the contract pays from escrow.</p>
      {open.map((e) => {
        const sealedLeft = calls.filter((c) => c.epoch === e && isSealed(c)).length;
        const ended = now >= club.started_at_ms + (e + 1) * epochMs;
        const settling = epochs.get(e)?.status === "Settling";
        return (
          <div key={e} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "8px 0" }}>
            <b>Epoch {e}</b>
            {settling ? <span>Scoring in OutLayer…</span>
              : sealedLeft ? <span className="fine" style={{ margin: 0 }}>{sealedLeft} sealed {sealedLeft === 1 ? "call" : "calls"} still to reveal</span>
              : !ended ? <span className="fine" style={{ margin: 0 }}>epoch still running</span>
              : account ? <button className="btn small" disabled={busy !== null} onClick={() => settle(e)}>{busy === e ? "Confirm in your wallet…" : "Settle (attach 0.5 NEAR for OutLayer)"}</button>
              : <span className="fine" style={{ margin: 0 }}>Sign in to settle</span>}
          </div>
        );
      })}
      {settled.map(([e, r]) => (
        <div key={e} className="pay">
          <span><b>Epoch {e} paid {near(r.paid)}</b> of a {near(r.budget)} budget</span>
          <span>{r.callers.filter((c) => BigInt(c.paid) > 0n).map((c) => `${c.caller} ${near(c.paid)}`).join(", ") || "no caller had a positive record"}</span>
        </div>
      ))}
      {msg && <p className="fine">{msg}</p>}
    </section>
  );
}
