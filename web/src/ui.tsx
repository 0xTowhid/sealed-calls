import { useState, type ReactNode } from "react";
import { countdown, dur, outcomeKind, outcomeText, pct, price, sig, when } from "./format";
import { chartUrl, mcapAtCall, usdShort, venueLabel } from "./markets";
import type { Signal, SignalBody } from "./types";
import { isSealed, opensAt } from "./types";

/** One block per signal, oldest first: won / lost / −100% / not filled / sealed. */
export function Ticks({ signals }: { signals: Signal[] }) {
  const list = [...signals].sort((a, b) => a.posted_at_ms - b.posted_at_ms).slice(-24);
  if (!list.length) return <span className="sub0">no signals yet</span>;
  return (
    <span className="ticks" aria-label="Every signal, oldest to newest">
      {list.map((s) => {
        const k = s.r_bps == null ? (isSealed(s) ? "s" : "p") : s.r_bps <= -10_000 ? "d" : s.r_bps > 0 ? "w" : s.r_bps === 0 ? "n" : "l";
        return <i key={s.id} className={k} title={s.r_bps == null ? "not scored yet" : `${pct(s.r_bps)} ${outcomeText(s.outcome)}`} />;
      })}
    </span>
  );
}

export function TickLegend() {
  return (
    <div className="legend">
      <span><i className="w" /> won</span>
      <span><i className="l" /> lost</span>
      <span><i className="d" /> −100% (liquidated, never opened, invalid)</span>
      <span><i className="n" /> never filled (0%)</span>
      <span><i className="s" /> still sealed</span>
    </div>
  );
}

export function SideTag({ b }: { b: SignalBody }) {
  if (b.market.venue !== "hyperliquid") return <span className="side long">SPOT BUY</span>;
  return <span className={`side ${b.side}`}>{b.side.toUpperCase()} {b.leverage}x</span>;
}

export function Outcome({ s }: { s: Signal }) {
  if (s.r_bps == null) return <span className="out s">{isSealed(s) ? `opens ${when(opensAt(s))}` : "scored at settlement"}</span>;
  return <span className={`out ${outcomeKind(s)}`}>{outcomeText(s.outcome)}</span>;
}

export function Result({ s, big }: { s: Signal; big?: boolean }) {
  const cls = s.r_bps == null ? "sub0" : s.r_bps > 0 ? "gain" : s.r_bps < 0 ? "loss" : "sub0";
  return <b className={`res ${cls} ${big ? "huge" : ""}`}>{s.r_bps == null ? "—" : s.r_bps === 0 ? "0%" : pct(s.r_bps)}</b>;
}

/** The signal itself, Telegram-style: side, market, leverage, levels, message. */
export function SignalFace({ b, validUntil, size = "l" }: { b: SignalBody; validUntil?: number; size?: "l" | "m" }) {
  const sell = b.side === "short";
  return (
    <div className={`face ${size}`}>
      <div className="tok">
        {b.market.venue !== "hyperliquid" ? <><span className="long">BUY</span> {b.market.symbol}{b.market.venue === "gecko_micro" && <> <MicroTag /></>}</> : <><span className={b.side}>{b.side.toUpperCase()}</span> {b.market.symbol} · {b.leverage}x</>}{" "}
        <span className="venue">{venueLabel(b.market)}</span>
      </div>
      <div className="levels">
        <div><span>{sell ? "Sell" : "Buy"}</span><b>{price(b.entry_low)}–{price(b.entry_high)}</b></div>
        <div><span>Take profit</span><b>{b.tps.map(price).join(" · ")}</b></div>
        <div><span>Stop loss</span><b>{price(b.sl)}</b></div>
        {validUntil != null && <div><span>Valid until</span><b>{when(validUntil)}</b></div>}
      </div>
      {b.msg && <p className="msg">“{b.msg}”</p>}
    </div>
  );
}

export function rangeState(b: SignalBody, now: number | null) {
  if (now == null) return null;
  const lo = Number(b.entry_low), hi = Number(b.entry_high);
  if (now >= lo && now <= hi) return "inside the range";
  return now < lo ? "below the range" : "above the range";
}

export function MarketLinks({ b }: { b: SignalBody }) {
  return (
    <>
      <a href={chartUrl(b.market)} target="_blank" rel="noreferrer">Chart</a>
      {b.market.venue === "hyperliquid" ? (
        <a href={`https://app.hyperliquid.xyz/trade/${b.market.address}`} target="_blank" rel="noreferrer">Trade on Hyperliquid</a>
      ) : (
        <a href={`https://www.geckoterminal.com/${b.market.network}/tokens/${b.market.address}`} target="_blank" rel="noreferrer">Pools</a>
      )}
    </>
  );
}

export function Countdown({ to, now }: { to: number; now: number }) {
  return <b className="mono">{countdown(to, now)}</b>;
}

export const validText = (s: Signal) => dur(s.valid_min);

/** A button that runs an async action and shows its error. */
export function Act({ label, busyLabel, run, className = "btn", disabled }: { label: ReactNode; busyLabel?: string; run: () => Promise<unknown>; className?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className={className}
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await run();
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? busyLabel ?? "Working…" : label}
      </button>
      {err && <div className="hint bad" role="alert">{err}</div>}
    </>
  );
}

// ------------------------------------------------------------------ live (unofficial) replay

import { useEffect as useEffectLive, useState as useStateLive } from "react";
import { replay, type Live } from "./score";

export function useLive(b: SignalBody | null, postedMs: number, validMin: number, enabled = true) {
  const [live, setLive] = useStateLive<Live | null>(null);
  useEffectLive(() => {
    if (!b || !enabled) return;
    let stop = false;
    const run = () => replay(b, postedMs, validMin).then((l) => !stop && setLive(l)).catch(() => {});
    run();
    const ended = Date.now() >= postedMs + validMin * 60_000;
    const t = ended ? undefined : setInterval(run, 60_000);
    return () => { stop = true; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b ? JSON.stringify(b) : "", postedMs, validMin, enabled]);
  return live;
}

const signed = (r: number) => `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r * 100).toFixed(1)}%`;

/** One line: where the signal stands now, replayed on public candles. */
export function LiveLine({ b, postedMs, validMin }: { b: SignalBody; postedMs: number; validMin: number }) {
  const l = useLive(b, postedMs, validMin);
  if (!l) return <div className="liveline sub0">Live status: checking the price history…</div>;
  const ended = Date.now() >= postedMs + validMin * 60_000;
  const cls = l.r == null || l.r === 0 ? "" : l.r > 0 ? "gain" : "loss";
  return (
    <div className="liveline">
      <b>{ended ? "Result so far" : "Live"}:</b>{" "}
      {l.fill == null ? (
        <>not filled{ended ? "" : " yet"}{l.last != null && <> · price {price(sig(l.last))}</>} · <b>0%</b></>
      ) : (
        <>filled at {price(sig(l.fill))}{l.fillAt ? ` (${when(l.fillAt)})` : ""} → <b>{l.outcome}</b> · <b className={cls}>{signed(l.r ?? 0)}</b>{l.state === "open" && <> at {price(sig(l.last ?? l.fill))}</>}</>
      )}
      <span className="sub0"> · unofficial until settlement</span>
    </div>
  );
}

/** Compact estimate for tables: "≈ −12.4%" and the outcome. */
export function LiveCells({ b, postedMs, validMin }: { b: SignalBody; postedMs: number; validMin: number }) {
  const l = useLive(b, postedMs, validMin);
  if (!l) return <><td><span className="out s">scoring…</span></td><td className="n sub0">…</td></>;
  const r = l.fill == null ? 0 : l.r ?? 0;
  return (
    <>
      <td><span className="out n" title="Replayed in your browser on the same public candles; OutLayer writes the official result at settlement.">{l.fill == null ? "not filled" : l.outcome} (est.)</span></td>
      <td className={`n ${r > 0 ? "gain" : r < 0 ? "loss" : "sub0"}`} title="Unofficial until settlement">≈ {r === 0 ? "0%" : signed(r)}</td>
    </>
  );
}

export function MicroTag() {
  return <span className="micro" title="Micro-cap signal: pool under the normal liquidity floor; scored with stricter rules">Micro-cap</span>;
}

/** "called at ≈ $42k mcap" for a micro-cap signal. */
export function McapAtCall({ b, fill }: { b: SignalBody; fill?: string | null }) {
  const [v, setV] = useStateLive<number | null>(null);
  const at = Number(fill ?? 0) || (Number(b.entry_low) + Number(b.entry_high)) / 2;
  useEffectLive(() => { if (b.market.venue === "gecko_micro") mcapAtCall(b.market, at).then(setV); }, [b.market.address, at]);
  if (b.market.venue !== "gecko_micro" || v == null) return null;
  return <div className="small sub0">called at ≈ {usdShort(v)} mcap</div>;
}

// ------------------------------------------------------------------ channel kinds

export const KINDS = [["perps", "Perps"], ["dex", "DEX tokens"], ["micro", "Micro-caps"]] as const;
const KIND_TAG: Record<string, string> = { perps: "Perps", dex: "DEX", micro: "Micro-caps" };
const VENUE_TAG = { hyperliquid: "perps", gecko: "dex", gecko_micro: "micro" } as const;

/** Declared kinds plus every kind actually revealed; nothing declared and nothing revealed = all kinds. */
export function kindsShown(tags: string[], signals: { body?: SignalBody | null }[]): string[] {
  const shown = new Set<string>(signals.flatMap((x) => (x.body ? [VENUE_TAG[x.body.market.venue]] : [])));
  const all = new Set([...tags, ...(tags.length ? shown : [])]);
  const out = tags.length ? KINDS.map(([k]) => k).filter((k) => all.has(k)) : KINDS.map(([k]) => k).filter((k) => shown.has(k));
  return out.length === 3 ? [] : out;
}

export function KindTags({ kinds }: { kinds: string[] }) {
  if (!kinds.length) return <span className="kind">All markets</span>;
  return <>{kinds.map((k) => <span key={k} className={`kind${k === "micro" ? " m" : ""}`}>{KIND_TAG[k]}</span>)}</>;
}

export function KindPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <>
      <label>What you post here</label>
      <div className="chips kinds" role="group" aria-label="What you post here">
        {KINDS.map(([k, name]) => (
          <button type="button" key={k} aria-pressed={value.includes(k)}
            onClick={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : KINDS.map(([x]) => x).filter((x) => x === k || value.includes(x)))}>{name}</button>
        ))}
      </div>
      <div className="hint">Pick one for a niche channel, or leave all off for all kinds. This decides which Explore tabs list the channel before its signals open. Once signals end, the channel also shows in the tab of every kind it actually posted.</div>
    </>
  );
}

// ------------------------------------------------------------------ identity + chart

/** A colour avatar derived from the account name (no images, same colours everywhere). */
export function Avatar({ id, size }: { id: string; size?: number }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 70 + (h >> 9) % 80) % 360, c = (b + 90) % 360;
  const style = { background: `conic-gradient(from ${(h >> 3) % 360}deg, hsl(${a} 85% 58%), hsl(${b} 85% 60%), hsl(${c} 80% 62%), hsl(${a} 85% 58%))`, ...(size ? { width: size, height: size } : {}) };
  return <span className="av" style={style} aria-hidden />;
}

/** Cumulative result, call by call (sum of each scored call's result), oldest to newest. */
export function ResultChart({ signals }: { signals: Signal[] }) {
  const pts = [...signals].filter((s) => s.r_bps != null).sort((a, b) => a.posted_at_ms - b.posted_at_ms);
  if (pts.length < 2) return <div className="none">The chart starts after two calls are scored.</div>;
  let acc = 0;
  const ys = [0, ...pts.map((s) => (acc += s.r_bps!))];
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), span = hi - lo || 1;
  const W = 800, H = 170, pad = 12;
  const x = (i: number) => (i / (ys.length - 1)) * W;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const line = ys.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const up = acc >= 0;
  const col = up ? "#078B55" : "#DC3D4B";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Cumulative result ${pct(acc)} over ${pts.length} calls`}>
      <defs><linearGradient id="cg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={up ? "#00EC97" : "#DC3D4B"} stopOpacity=".25" /><stop offset="1" stopColor={up ? "#00EC97" : "#DC3D4B"} stopOpacity="0" /></linearGradient></defs>
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="#D7DCD9" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#cg)" />
      <path d={line} fill="none" stroke={col} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
