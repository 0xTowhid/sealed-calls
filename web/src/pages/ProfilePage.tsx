import type { ClubData } from "../data";
import { record } from "../data";
import { Ledger } from "../Ledger";
import { near, pct } from "../format";

export function ProfilePage({ data, caller, account, reload }: { data: ClubData; caller: string; account: string | null; reload: () => void }) {
  const { club, calls, epochs } = data;
  const mine = calls.filter((c) => c.caller === caller);
  const r = record(mine);
  const onRoster = club.callers.includes(caller);
  const payouts = [...epochs.entries()]
    .map(([e, res]) => ({ e, paid: BigInt(res.callers.find((x) => x.caller === caller)?.paid ?? "0") }))
    .filter((p) => p.paid > 0n)
    .sort((a, b) => b.e - a.e);

  return (
    <section className="sheet">
      <div className="prof">
        <div>
          <h1 style={{ wordBreak: "break-all" }}>{caller}</h1>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            {onRoster ? `Every call since joining ${club.config.name}. Nothing can be removed.` : `Not on ${club.config.name}'s caller roster.`}
          </p>
        </div>
        <div className="stats">
          <div><b>{r.total}</b>calls</div>
          <div><b>{pct(r.score_bps)}</b>score</div>
          <div><b>{r.positive} / {r.scored}</b>positive</div>
        </div>
      </div>
      <Ledger calls={mine} club={club} account={account} reload={reload} />
      {payouts.map((p) => (
        <div key={p.e} className="pay">
          <span><b>Epoch {p.e} paid {near(p.paid)}</b> from the club escrow</span>
          <span>Scored in OutLayer</span>
        </div>
      ))}
      <p className="fine">Results are indicative returns for a $500 trade: entry is the first traded minute after posting, exit the median of the last 30 minutes, minus estimated fees and price impact. Losses, unopened calls, thin pools and duplicates stay on this page.</p>
    </section>
  );
}
