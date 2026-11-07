import { useEffect, useState } from "react";
import type { ClubData } from "../data";
import { useNow } from "../data";
import { GECKO, NEAR } from "../config";
import { call as tx, signIn } from "../near";
import { roundFor, seal } from "../crypto";
import { clock, horizon } from "../format";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Lookup = { symbol: string | null; liquidity: number | null } | "error" | null;

export function PostPage({ data, account, reload }: { data: ClubData; account: string | null; reload: () => void }) {
  const { club } = data;
  const now = useNow(1000);
  const [mint, setMint] = useState("");
  const [h, setH] = useState(club.config.horizons_min[0]);
  const [look, setLook] = useState<Lookup>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = MINT_RE.test(mint.trim());
  const members = club.members.filter((m) => m.pubkey).map((m) => ({ member: m.account, pubkey: m.pubkey! }));
  const opens = now + h * 60_000 + 60_000;

  useEffect(() => {
    setLook(null);
    if (!valid) return;
    const m = mint.trim();
    const ctl = new AbortController();
    Promise.all([
      fetch(`${GECKO}/tokens/${m}`, { signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${GECKO}/tokens/${m}/pools`, { signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([t, p]) => {
        const id = (x: { relationships?: Record<string, { data?: { id?: string } }> }, k: string) => x.relationships?.[k]?.data?.id?.replace("solana_", "");
        const pools = (p?.data ?? []) as { attributes: { reserve_in_usd: string }; relationships: Record<string, { data?: { id?: string } }> }[];
        const liq = pools
          .filter((x) => [SOL, USDC].includes(id(x, "quote_token") ?? "") || [SOL, USDC].includes(id(x, "base_token") ?? ""))
          .map((x) => Number(x.attributes.reserve_in_usd))
          .sort((a, b) => b - a)[0];
        setLook({ symbol: t?.data?.attributes?.symbol ?? null, liquidity: Number.isFinite(liq) ? liq : null });
      })
      .catch((e) => { if (e.name !== "AbortError") setLook("error"); });
    return () => ctl.abort();
  }, [mint, valid]);

  if (!account)
    return (
      <section className="sheet" style={{ maxWidth: 480 }}>
        <h2>Post a call</h2>
        <p className="sub">Only callers on the club's roster can post. Sign in first.</p>
        <button className="btn" onClick={() => signIn()}>Sign in</button>
      </section>
    );
  const onRoster = club.callers.includes(account);

  async function post() {
    setMsg(null);
    try {
      setBusy("Sealing…");
      const { args } = await seal({ club: club.id, caller: account!, mint: mint.trim(), horizonMin: h, members });
      setBusy("Confirm in your wallet…");
      await tx("post_call", args, NEAR(0.1));
      setMsg({ ok: true, text: `Posted. Members can read it now; it opens for everyone around ${clock(opens)}.` });
      setMint("");
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const floorOk = look && look !== "error" && look.liquidity != null && look.liquidity >= 100_000;
  return (
    <div className="grid2">
      <section className="sheet">
        <h2>Post a call</h2>
        <p className="sub">Members see it now. Everyone else sees it when it ends.</p>
        {!onRoster && <div className="notice">{account} isn't on this club's caller roster, so the contract will refuse the post.</div>}
        <label htmlFor="mint">Token (Solana mint address)</label>
        <input id="mint" type="text" spellCheck={false} autoComplete="off" placeholder="e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" value={mint} onChange={(e) => setMint(e.target.value)} />
        {mint && !valid && <div className="hint bad">That isn't a Solana address.</div>}
        {valid && look === null && <div className="hint">Looking up the token…</div>}
        {look === "error" && <div className="hint">Couldn't look the token up. You can still post; scoring checks the pool later.</div>}
        {look && look !== "error" && (
          <div className={`hint ${floorOk ? "ok" : "bad"}`}>
            {look.symbol ?? "Unknown token"} · {look.liquidity == null ? "no SOL/USDC pool found: this call would score −100%" : `deepest SOL/USDC pool $${Math.round(look.liquidity).toLocaleString()}${floorOk ? " ✓" : ": under the $100k floor, this call would score −100%"}`}
          </div>
        )}
        <label id="hz">Horizon</label>
        <div className="seg" role="group" aria-labelledby="hz">
          {club.config.horizons_min.map((x) => (
            <button key={x} aria-pressed={x === h} onClick={() => setH(x)}>{horizon(x)}</button>
          ))}
        </div>
        <div className="when">
          <div><b>Now</b><span>{members.length} {members.length === 1 ? "member" : "members"} can read it</span></div>
          <div><b>{clock(opens)}</b><span>Opens for everyone (drand round {roundFor(Math.floor(opens / 1000)).toLocaleString()})</span></div>
          <div><b>Then</b><span>Scored as a $500 trade</span></div>
        </div>
        <button className="btn wide" disabled={!valid || !onRoster || !!busy} onClick={post}>{busy ?? "Seal and post"}</button>
        <p className="fine">Once posted, this call can't be edited or deleted. If it is never revealed it counts as −100%. Posting attaches 0.1 NEAR for storage; the unused part is refunded.</p>
        {msg && <div className={`notice ${msg.ok ? "" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
      </section>
      <section className="sheet">
        <h2>How a call is scored</h2>
        <dl className="kv">
          <dt>Entry</dt><dd>Close of the first traded minute after your post (pre-buying can't improve it)</dd>
          <dt>Exit</dt><dd>Median close over the last 30 minutes of the horizon; with fewer than 10 traded minutes, the lowest close</dd>
          <dt>Costs</dt><dd>Pool fee plus price impact for a $500 trade, each way</dd>
          <dt>−100%</dt><dd>No SOL/USDC pool over $100k, no trade within 15 minutes, never revealed, or a second open call on the same token</dd>
        </dl>
      </section>
    </div>
  );
}
