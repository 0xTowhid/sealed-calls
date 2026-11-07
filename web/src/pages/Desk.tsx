import { useEffect, useMemo, useState } from "react";
import { call, currentPeriod, getConfig, listChannels, periodHeld, readersNow, subscribers } from "../near";
import { useLoad, useNow } from "../data";
import { dur, near, pct, periodWord, planName, price, sig, when } from "../format";
import { seal } from "../crypto";
import { priceOf, searchMarkets, type Found } from "../markets";
import { Act, SignalFace } from "../ui";
import { HL_TAKER_FEE, NEAR } from "../config";
import type { Channel, SignalBody } from "../types";

async function load(account: string) {
  const [cfg, channels] = await Promise.all([getConfig(), listChannels()]);
  const mine = channels.find((c) => c.creator === account) ?? null;
  if (!mine) return { cfg, mine, subs: [] as [string, number, boolean][], held: "0" };
  const [subs, cur] = await Promise.all([subscribers(mine.id), currentPeriod(mine.id)]);
  const held = await periodHeld(mine.id, cur);
  return { cfg, mine, subs, held };
}

export function Desk({ account }: { account: string | null }) {
  const { data, error, reload } = useLoad(() => (account ? load(account) : Promise.resolve(null)), [account], 30_000);
  if (!account) return <section className="sheet"><h2>Creator desk</h2><p className="sub">Connect a wallet to start a channel or post signals.</p></section>;
  if (error) return <div className="notice err">{error}</div>;
  if (!data) return <p className="empty">Reading your channel…</p>;
  if (!data.mine) return <CreateChannel onDone={reload} word={periodWord(data.cfg.period_minutes)} />;
  return <Compose ch={data.mine} account={account} subs={data.subs} held={data.held} periodMinutes={data.cfg.period_minutes} />;
}

// ------------------------------------------------------------------ create a channel

const DEFAULT_PLANS = [
  { days: 7, price: "2" },
  { days: 14, price: "3.5" },
  { days: 30, price: "6" },
  { days: 180, price: "30" },
  { days: 365, price: "50" },
];

function CreateChannel({ onDone, word }: { onDone: () => void; word: string }) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [max, setMax] = useState("100");
  const [plans, setPlans] = useState(DEFAULT_PLANS);
  const valid = name.trim() && plans.some((p) => Number(p.price) > 0);
  return (
    <div className="g-desk">
      <section className="sheet">
        <h2>Start your channel</h2>
        <p className="sub">Anyone can be a creator. Subscribers pay you: half arrives at once, the other half each {word} your signals make money.</p>
        <label htmlFor="cn">Channel name</label>
        <input id="cn" type="text" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} placeholder="e.g. 0xTowhid Calls" />
        <label htmlFor="ca">What you post</label>
        <textarea id="ca" value={about} maxLength={400} onChange={(e) => setAbout(e.target.value)} placeholder="Perps and Solana memecoins. Usually 3–10x, 1–3 days." />
        <label>Prices in NEAR <span className="sub0">(leave empty to skip a plan)</span></label>
        <div className="plan-edit">
          {plans.map((p, i) => (
            <div key={p.days}>
              <span>{planName(p.days)}</span>
              <input type="text" inputMode="decimal" value={p.price} onChange={(e) => setPlans(plans.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        <label htmlFor="cm">Most subscribers at once</label>
        <input id="cm" type="text" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} />
        <div className="hint">Up to 100. Each signal is encrypted to every subscriber, so more seats cost a little more storage per signal.</div>
        <Act className="btn wide" label="Create channel" busyLabel="Waiting for the wallet…" disabled={!valid}
          run={async () => {
            const ps = plans.filter((p) => Number(p.price) > 0).map((p) => ({ days: p.days, price: NEAR(Number(p.price)) }));
            await call("create_channel", { name: name.trim(), about: about.trim(), plans: ps, max_members: Math.min(100, Math.max(1, Number(max) || 1)) }, NEAR(0.05));
            onDone();
          }} />
      </section>
      <section className="sheet">
        <h2>How you earn</h2>
        <div className="split" aria-hidden><i /><i className="held" /></div>
        <dl className="kv">
          <dt>Subscribe</dt><dd>Half the price goes to you immediately.</dd>
          <dt>The other half</dt><dd>is spread over the {word}s the subscription covers and held by the contract.</dd>
          <dt>Each {word}</dt><dd>If your signals posted that {word} have a positive score, you get that {word}'s held part. If not, or you posted nothing, subscribers can claim it back.</dd>
          <dt>Your record</dt><dd>Every signal becomes public when it ends and stays on your page forever, wins and losses.</dd>
        </dl>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ compose

const UNITS = { m: 1, h: 60, d: 1440 } as const;
const QUICK: [string, number][] = [["1h", 60], ["4h", 240], ["1d", 1440], ["3d", 4320], ["1w", 10080]];
const clean = (s: string) => s.replace(/,/g, "").trim();
const num = (s: string) => (/^\d*\.?\d+$/.test(clean(s)) ? Number(clean(s)) : NaN);

function Compose({ ch, account, subs, held, periodMinutes }: { ch: Channel; account: string; subs: [string, number, boolean][]; held: string; periodMinutes: number }) {
  const now = useNow(10_000);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [sel, setSel] = useState<Found | null>(null);
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState(5);
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  const [tps, setTps] = useState(["", "", ""]);
  const [sl, setSl] = useState("");
  const [vNum, setVNum] = useState("3");
  const [vUnit, setVUnit] = useState<keyof typeof UNITS>("d");
  const [msg, setMsg] = useState("");
  const [live, setLive] = useState<number | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim() || sel) return;
    const t = setTimeout(() => searchMarkets(q).then(setFound), 350);
    return () => clearTimeout(t);
  }, [q, sel]);
  useEffect(() => {
    if (!sel) return;
    priceOf(sel.market).then(setLive);
    const t = setInterval(() => priceOf(sel.market).then(setLive), 15_000);
    return () => clearInterval(t);
  }, [sel]);

  const dex = sel?.market.venue === "gecko";
  const eSide = dex ? "long" : side;
  const eLev = dex ? 1 : lev;
  const maxLev = sel?.maxLeverage ?? 50;
  const validMin = Math.round((Number(vNum) || 0) * UNITS[vUnit]);
  const tpList = tps.map(clean).filter(Boolean);

  const problem = useMemo(() => {
    if (!sel) return "Pick a market.";
    const [l, h, s] = [num(lo), num(hi || lo), num(sl)];
    const t = tpList.map(num);
    if ([l, h, s, ...t].some((x) => !(x > 0))) return "Fill in the buy range, at least one take-profit and the stop loss.";
    if (l > h) return "The low end of the range is above the high end.";
    if (!t.length) return "Add at least one take-profit.";
    if (eSide === "long") {
      if (s >= l) return "For a long, the stop loss must be below the buy range.";
      if (t.some((x) => x <= h) || t.some((x, i) => i > 0 && x <= t[i - 1])) return "For a long, take-profits must be above the range, each higher than the last.";
    } else {
      if (s <= h) return "For a short, the stop loss must be above the sell range.";
      if (t.some((x) => x >= l) || t.some((x, i) => i > 0 && x >= t[i - 1])) return "For a short, take-profits must be below the range, each lower than the last.";
    }
    if (validMin < 15 || validMin > 43_200) return "Validity must be between 15 minutes and 30 days.";
    if (eLev < 1 || eLev > maxLev) return `Leverage must be 1–${maxLev}x on this market.`;
    return null;
  }, [sel, lo, hi, sl, tpList, eSide, validMin, eLev, maxLev]);

  const body: SignalBody | null = sel
    ? { market: sel.market, side: eSide, leverage: eLev, entry_low: clean(lo), entry_high: clean(hi || lo), tps: tpList, sl: clean(sl), msg: msg.trim() }
    : null;

  // What-if numbers at the middle of the range (same formula as the scorer).
  const mid = (num(lo) + num(hi || lo)) / 2;
  const fee = dex ? 0 : HL_TAKER_FEE * 2;
  const at = (x: number) => Math.max(-1, eLev * (eSide === "long" ? x / mid - 1 : 1 - x / mid) - eLev * fee);
  const liq = eLev > 1 || eSide === "short" ? (eSide === "long" ? mid * (1 - 1 / eLev) : mid * (1 + 1 / eLev)) : null;
  const risk = Math.abs(mid - num(sl));
  const word = periodWord(periodMinutes);
  const readers = subs.filter((s) => s[2]).length;
  const inRange = live != null && body ? (live >= num(body.entry_low) && live <= num(body.entry_high) ? "inside your range: it fills on the next candle" : live < num(body.entry_low) ? "below your range" : "above your range") : null;

  const post = async () => {
    if (!body || problem) return;
    const rs = await readersNow(ch.id);
    const { args } = await seal({ channel: ch.id, creator: account, validMin, signal: body, readers: rs.map(([member, pubkey]) => ({ member, pubkey })) });
    await call("post_signal", args, NEAR(0.1));
    setPosted(`Posted. ${rs.length} subscriber${rs.length === 1 ? "" : "s"} can read it now; it opens for everyone ${when(Date.now() + validMin * 60_000)}.`);
    setSel(null); setQ(""); setFound([]); setLo(""); setHi(""); setTps(["", "", ""]); setSl(""); setMsg("");
  };

  return (
    <div className="g-desk">
      <section className="sheet">
        <h2>New signal</h2>
        {posted && <div className="notice ok-n" role="status">{posted} <a href={`#/c/${ch.id}`}>See your channel</a></div>}
        <label htmlFor="mk">Market</label>
        <input id="mk" type="text" value={sel ? `${sel.market.symbol} · ${sel.label}` : q} placeholder="Ticker or token address, e.g. ETH, BONK, WIF"
          onChange={(e) => { setSel(null); setQ(e.target.value); }} autoComplete="off" />
        {!sel && found.length > 0 && (
          <div className="drop" role="listbox">
            {found.map((f, i) => (
              <button key={i} role="option" onClick={() => { setSel(f); setFound([]); if (f.market.venue === "gecko") setLev(1); }}>
                <span><b>{f.market.symbol}</b> {f.label}</span>
                <span className="sub0">{f.price ? `$${price(sig(f.price))}` : ""}{f.liquidity ? ` · pool $${(f.liquidity / 1e6).toFixed(1)}M` : ""} · {f.market.venue === "hyperliquid" ? `long or short, up to ${f.maxLeverage}x` : "long, 1x"}</span>
              </button>
            ))}
          </div>
        )}
        {!sel && q.trim() && found.length === 0 && <div className="hint">Searching Hyperliquid and DEX pools…</div>}
        {sel && sel.liquidity != null && sel.liquidity < 100_000 && <div className="hint bad">This pool has under $100k liquidity: the signal would score −100%.</div>}

        <div className="two">
          <div>
            <label>Direction</label>
            <div className="seg dir">
              <button aria-pressed={eSide === "long"} className="l" onClick={() => setSide("long")}>Long</button>
              <button aria-pressed={eSide === "short"} className="s" disabled={dex} onClick={() => setSide("short")}>Short</button>
            </div>
            {dex && <div className="hint">DEX tokens are long only.</div>}
          </div>
          <div>
            <label htmlFor="lev">Leverage <b className="right">{eLev}x</b></label>
            <input id="lev" type="range" min={1} max={dex ? 1 : maxLev} value={eLev} disabled={dex} onChange={(e) => setLev(Number(e.target.value))} />
            <div className="hint row-between"><span>1x</span><span>{dex ? "1x" : `${maxLev}x`}</span></div>
          </div>
        </div>

        <label>{eSide === "long" ? "Buy" : "Sell"} range</label>
        <div className="two"><input type="text" inputMode="decimal" placeholder="from" value={lo} onChange={(e) => setLo(e.target.value)} /><input type="text" inputMode="decimal" placeholder="to (optional)" value={hi} onChange={(e) => setHi(e.target.value)} /></div>
        <label>Take profit <span className="sub0">(1 to 3; each closes an equal part)</span></label>
        <div className="three">
          {tps.map((t, i) => <input key={i} type="text" inputMode="decimal" placeholder={i ? `TP${i + 1} (optional)` : "TP1"} value={t} onChange={(e) => setTps(tps.map((x, j) => (j === i ? e.target.value : x)))} />)}
        </div>
        <label htmlFor="sl">Stop loss</label>
        <input id="sl" type="text" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} />
        <label>Valid for</label>
        <div className="two">
          <div className="valid">
            <input type="text" inputMode="decimal" value={vNum} onChange={(e) => setVNum(e.target.value)} aria-label="Validity amount" />
            <select value={vUnit} onChange={(e) => setVUnit(e.target.value as keyof typeof UNITS)} aria-label="Validity unit">
              <option value="m">minutes</option><option value="h">hours</option><option value="d">days</option>
            </select>
          </div>
          <div className="chips">
            {QUICK.map(([l, m]) => (
              <button key={l} aria-pressed={validMin === m} onClick={() => { if (m % 1440 === 0) { setVNum(String(m / 1440)); setVUnit("d"); } else { setVNum(String(m / 60)); setVUnit("h"); } }}>{l}</button>
            ))}
          </div>
        </div>
        <label htmlFor="msg">Message <span className="sub0">(sealed with the signal)</span></label>
        <textarea id="msg" maxLength={280} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Why this trade, how you'd manage it." />
        {problem && (sel || lo || sl) && <div className="hint bad">{problem}</div>}
        <Act className="btn wide" label="Seal and post" busyLabel="Sealing…" disabled={!!problem} run={post} />
        <div className="fine">Can't be edited or deleted. Attaches 0.1 NEAR for storage; the unused part comes back.</div>
      </section>

      <div>
        <div className="sub0 small" style={{ marginBottom: 8 }}>What your {readers} subscriber{readers === 1 ? "" : "s"} see now</div>
        <div className="card fresh">
          <div className="tape" />
          <div className="hd"><span><b>{ch.name}</b> · just now</span><span>public in <b className="mono">{validMin ? `${Math.floor(validMin / 60)}:${String(validMin % 60).padStart(2, "0")}:00` : "—"}</b></span></div>
          <div className="bd">
            {body ? <SignalFace b={{ ...body, entry_low: body.entry_low || "…", entry_high: body.entry_high || "…", sl: body.sl || "…", tps: body.tps.length ? body.tps : ["…"] }} validUntil={now + validMin * 60_000} /> : <p className="sub0">Pick a market to see the preview.</p>}
          </div>
        </div>

        <section className="sheet" style={{ marginTop: 26 }}>
          <h2>Check before posting</h2>
          <dl className="kv">
            <dt>Price now</dt><dd>{live == null ? "—" : `${price(sig(live))}${inRange ? `, ${inRange}` : ""}`}</dd>
            {!problem && <>
              <dt>At {tpList.map((_, i) => `TP${i + 1}`).join(" / ")}</dt><dd className="gain"><b>{tpList.map((t) => pct(Math.round(at(num(t)) * 10_000))).join(" / ")}</b> at {eLev}x{dex ? ", before DEX costs" : ", after fees"}</dd>
              <dt>At SL</dt><dd className="loss"><b>{pct(Math.round(at(num(sl)) * 10_000))}</b> at {eLev}x</dd>
              <dt>Liquidation</dt><dd>{liq == null ? "none at 1x long" : `≈ ${price(sig(liq))}${(eSide === "long" ? liq >= num(sl) : liq <= num(sl)) ? ": before your stop loss — this signal would be liquidated first" : ": beyond your SL, fine"}`}</dd>
              <dt>Reward : risk</dt><dd>{tpList.map((t, i) => `${(Math.abs(num(t) - mid) / risk).toFixed(1)} (TP${i + 1})`).join(" · ")}</dd>
            </>}
          </dl>
          <div className="when">
            <div><b className="mono">now</b><span>{readers} subscriber{readers === 1 ? "" : "s"} get it in their feed</span></div>
            <div><b className="mono">{validMin ? when(now + validMin * 60_000) : "—"}</b><span>Opens for everyone, scored, added to your record ({dur(validMin || 0)})</span></div>
            <div><b className="mono">this {word}</b><span>Counts toward this {word}'s held {near(held)}</span></div>
          </div>
        </section>

        <section className="sheet" style={{ marginTop: 26 }}>
          <div className="row-between"><h2>Who reads your signals</h2><a href={`#/c/${ch.id}`} className="small">Your public page</a></div>
          <p className="sub">{subs.length} active subscriber{subs.length === 1 ? "" : "s"} of {ch.max_members}. Earned so far: <b>{near(ch.stats.earned)}</b>.</p>
          {subs.length === 0 ? <p className="sub0">Nobody yet. Share your channel link.</p> : subs.slice(0, 12).map(([a, until, hasKey]) => (
            <div className="mem" key={a}><span>{a}</span><span className={hasKey ? "ok" : "wait"}>{hasKey ? `reads your signals · until ${when(until)}` : "subscribed, hasn't opened the app yet"}</span></div>
          ))}
        </section>
      </div>
    </div>
  );
}
