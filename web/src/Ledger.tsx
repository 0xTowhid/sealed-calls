import { useState } from "react";
import type { Call, Club } from "./types";
import { isSealed, isUnrevealed, opensAt } from "./types";
import { clock, horizon, noteText, pct, tokenLabel, until, when } from "./format";
import { call as tx } from "./near";
import { loadMemberKey, memberOpen, tlockOpen } from "./crypto";
import { useNow } from "./data";

/** The public record: every call is a row and nothing collapses. */
export function Ledger({ calls, club, account, showCaller, reload }: {
  calls: Call[]; club: Club; account: string | null; showCaller?: boolean; reload: () => void;
}) {
  const now = useNow(1000);
  if (!calls.length) return <div className="empty">No calls yet.</div>;
  return (
    <div className="ledger-wrap">
      <table>
        <thead>
          <tr>
            <th>Posted</th>
            {showCaller && <th>Caller</th>}
            <th>Token</th><th>Horizon</th>
            <th className="n">Entry</th><th className="n">Exit</th><th className="n">Cost</th><th className="n">Result</th>
            <th>Note</th><th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => {
            const sealed = isSealed(c);
            const loss = (c.score_bps ?? 0) < 0;
            const cls = sealed ? "sealed" : loss ? "loss" : "";
            return (
              <tr key={c.id} className={cls}>
                <td>{when(c.posted_at_ms)}</td>
                {showCaller && <td><a href={`#/caller/${c.caller}`}>{c.caller}</a></td>}
                <td className="tok">{tokenLabel(c)}</td>
                <td>{horizon(c.horizon_min)}</td>
                <td className="n">{c.entry_usd ?? "—"}</td>
                <td className="n">{c.exit_usd ?? "—"}</td>
                <td className="n">{c.cost_bps != null ? pct(c.cost_bps, false) : "—"}</td>
                <td className={`n res ${(c.score_bps ?? 0) > 0 ? "gain" : ""}`}>{pct(c.score_bps)}</td>
                <td>{sealed ? (now < opensAt(c) ? `opens ${clock(opensAt(c))} (${until(opensAt(c), now)})` : "ready to open") : isUnrevealed(c) ? "never opened" : c.score_bps == null ? "waiting for settlement" : noteText(c)}</td>
                <td><RowAction c={c} club={club} account={account} now={now} reload={reload} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowAction({ c, club, account, now, reload }: { c: Call; club: Club; account: string | null; now: number; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!isSealed(c) || now < opensAt(c)) return null;
  const graceOver = now >= opensAt(c) + club.config.grace_min * 60_000;

  async function reveal() {
    setErr(null);
    try {
      setBusy("Opening…");
      let opened;
      try {
        opened = await tlockOpen(c);
      } catch (e) {
        // drand round not reached yet or unreachable: a member can still reveal from their copy.
        const key = account ? loadMemberKey(c.club, account) : null;
        if (!key) throw e;
        opened = await memberOpen(c, account!, key);
      }
      if (!opened.matches) throw new Error("The opened call doesn't match its commitment.");
      setBusy("Confirm in your wallet…");
      await tx("reveal", { call_id: c.id, plaintext: opened.plaintext });
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function markUnrevealed() {
    setErr(null);
    try { setBusy("Confirm in your wallet…"); await tx("mark_unrevealed", { call_id: c.id }); reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  if (!account) return <span className="fine">Sign in to open it</span>;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button className="btn small" onClick={reveal} disabled={!!busy}>{busy ?? "Reveal"}</button>
      {graceOver && <button className="btn small ghost" onClick={markUnrevealed} disabled={!!busy}>Mark unrevealed</button>}
      {err && <span className="bad" style={{ fontSize: 12.5, whiteSpace: "normal" }}>{err}</span>}
    </span>
  );
}
