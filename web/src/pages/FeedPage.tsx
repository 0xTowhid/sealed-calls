import { useEffect, useState } from "react";
import type { ClubData } from "../data";
import { useNow } from "../data";
import type { Call } from "../types";
import { isSealed, opensAt } from "../types";
import { horizon, pct, short, tokenLabel, until, when } from "../format";
import { loadMemberKey, memberOpen, newMemberKey, type MemberKey, type Opened } from "../crypto";
import { call as tx, signIn } from "../near";

export function FeedPage({ data, account, reload }: { data: ClubData; account: string | null; reload: () => void }) {
  const { club, calls } = data;
  const [key, setKey] = useState<MemberKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setKey(account ? loadMemberKey(club.id, account) : null), [account, club.id]);

  if (!account)
    return (
      <section className="sheet">
        <h2>Member feed</h2>
        <p className="sub">Members read calls as soon as they're posted. Sign in with a member account.</p>
        <button className="btn" onClick={() => signIn()}>Sign in</button>
      </section>
    );

  const me = club.members.find((m) => m.account === account);
  const registered = me?.pubkey ?? null;
  const keyOk = !!key && key.publicKey === registered;

  async function register() {
    setMsg(null); setBusy(true);
    try {
      const k = await newMemberKey(club.id, account!);
      await tx("register_key", { club: club.id, pubkey: k.publicKey });
      setKey(k);
      setMsg("Key registered. Calls posted from now on are encrypted to it.");
      reload();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="sheet">
      <h2>Member feed</h2>
      <p className="sub">{club.config.name} · {club.callers.length} {club.callers.length === 1 ? "caller" : "callers"}</p>
      {!me && <div className="notice">{account} isn't a member of this club. The club's DAO adds members.</div>}
      {me && !keyOk && (
        <div className="notice">
          {registered && !key
            ? "This browser doesn't hold your member key, so earlier calls stay sealed for you here. Create a new key to read calls posted from now on."
            : "Create your member key to read calls. It stays in this browser; only its public half goes on-chain."}
          <div style={{ marginTop: 10 }}>
            <button className="btn small" disabled={busy} onClick={register}>{busy ? "Confirm in your wallet…" : "Create my member key"}</button>
          </div>
        </div>
      )}
      {msg && <p className="fine">{msg}</p>}
      {calls.length === 0 && <div className="empty">No calls yet.</div>}
      {calls.map((c) => <FeedCard key={c.id} c={c} account={account} memberKey={keyOk ? key : null} />)}
    </section>
  );
}

function FeedCard({ c, account, memberKey }: { c: Call; account: string; memberKey: MemberKey | null }) {
  const now = useNow(1000);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const wrappedToMe = c.wrapped_keys.some((w) => w.member === account);
  const sealed = isSealed(c);

  useEffect(() => {
    if (!sealed || !memberKey || !wrappedToMe) return;
    memberOpen(c, account, memberKey).then(setOpened).catch(() => setWhy("Your key couldn't open this call."));
  }, [c, account, memberKey, sealed, wrappedToMe]);

  const head = (
    <div className="hd">
      <span><a href={`#/caller/${c.caller}`}><b>{c.caller}</b></a> · {when(c.posted_at_ms)}</span>
      <span>{sealed ? (now < opensAt(c) ? `Public in ${until(opensAt(c), now)}` : "Ready to open") : "Ended"}</span>
    </div>
  );

  if (!sealed)
    return (
      <div className="call">
        {head}
        <div className="bd">
          <div className="big" style={{ fontSize: 19 }}>Long {tokenLabel(c)} · {horizon(c.horizon_min)}</div>
          {c.score_bps == null ? <span>Waiting for settlement</span>
            : <><span className={c.score_bps > 0 ? "ok" : "bad"}>{pct(c.score_bps)}</span> after costs</>}
        </div>
      </div>
    );

  if (opened)
    return (
      <div className="call reveal-in">
        {head}
        <div className="bd">
          <div className="big">Long {short(opened.mint, 6, 4)} · {horizon(c.horizon_min)}</div>
          <div className="mono" style={{ margin: "2px 0 4px", wordBreak: "break-all" }}>{opened.mint}</div>
          {opened.matches
            ? <div className="ok">✓ Matches commitment <span className="mono">{short(c.commit, 4, 4)}</span></div>
            : <div className="bad">✗ Doesn't match its commitment: the caller sent members a different call than the one on record</div>}
        </div>
      </div>
    );

  return (
    <div className="call closed">
      <div className="strip" />
      {head}
      <div className="bd" style={{ fontSize: 14 }}>
        {why ?? (wrappedToMe ? "Opening…" : "Sealed for you: you joined or created your key after this call was posted.")}
        <br /><span className="mono">commit {short(c.commit, 4, 4)}</span>
      </div>
    </div>
  );
}
