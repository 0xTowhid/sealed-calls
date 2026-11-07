import { useEffect, useState } from "react";
import { allSignals, call, claimable, getMember, listChannels } from "../near";
import { useLoad, useNow } from "../data";
import { costPct, near, price, sig, when } from "../format";
import { loadMemberKey, memberOpen, newMemberKey, type Opened } from "../crypto";
import { priceOf } from "../markets";
import { Act, Countdown, MarketLinks, Outcome, Result, SignalFace, rangeState } from "../ui";
import type { Channel, Member, Signal } from "../types";
import { isSealed, opensAt } from "../types";

type Sub = { ch: Channel; m: Member; claim: [string, number[]] };

async function load(account: string) {
  const channels = await listChannels();
  const subs: Sub[] = [];
  await Promise.all(
    channels.map(async (ch) => {
      const m = await getMember(ch.id, account);
      if (m) subs.push({ ch, m, claim: await claimable(ch.id, account) });
    }),
  );
  subs.sort((a, b) => b.m.until_ms - a.m.until_ms);
  const signals = (await Promise.all(subs.map((s) => allSignals(s.ch.id, s.ch.signal_count)))).flat().sort((a, b) => b.posted_at_ms - a.posted_at_ms);
  return { subs, signals };
}

export function Feed({ account }: { account: string | null }) {
  const { data, error, reload } = useLoad(() => (account ? load(account) : Promise.resolve(null)), [account], 20_000);
  const now = useNow(1000);
  const [opened, setOpened] = useState<Record<number, Opened | string>>({});
  const [prices, setPrices] = useState<Record<number, number | null>>({});

  // Decrypt sealed signals wrapped to this browser's key.
  useEffect(() => {
    if (!data || !account) return;
    for (const s of data.signals) {
      if (!isSealed(s) || opened[s.id]) continue;
      const key = loadMemberKey(s.channel, account);
      if (!key || !s.wrapped_keys.some((w) => w.member === account)) continue;
      memberOpen(s, account, key)
        .then((o) => setOpened((x) => ({ ...x, [s.id]: o })))
        .catch(() => setOpened((x) => ({ ...x, [s.id]: "This browser's key can't open it (set up on another device?)." })));
    }
  }, [data, account, opened]);

  // Live prices for open signals.
  useEffect(() => {
    const live = Object.entries(opened).filter(([, o]) => typeof o !== "string" && o.body) as [string, Opened][];
    const tick = () => live.forEach(([id, o]) => priceOf(o.body!.market).then((p) => setPrices((x) => ({ ...x, [Number(id)]: p }))));
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, [opened]);

  if (!account) return <section className="sheet"><h2>My feed</h2><p className="sub">Connect a wallet to see the channels you subscribe to.</p></section>;
  if (error) return <div className="notice err">{error}</div>;
  if (!data) return <p className="empty">Reading your subscriptions…</p>;
  const { subs, signals } = data;
  const needKey = subs.filter((s) => s.m.until_ms > now && (!s.m.pubkey || loadMemberKey(s.ch.id, account)?.publicKey !== s.m.pubkey));
  const refund = subs.filter((s) => BigInt(s.claim[0]) > 0n);
  const name = (id: number) => subs.find((s) => s.ch.id === id)?.ch.name ?? `#${id}`;

  return (
    <div className="g-feed">
      <div>
        {needKey.map((s) => (
          <div className="notice" key={s.ch.id}>
            <b>Set up this browser to read {s.ch.name}.</b> Signals are encrypted to a key that lives in your browser. Signals posted before you set it up open for you when they open for everyone.
            <div style={{ marginTop: 8 }}>
              <Act className="btn small" label="Set up this browser" run={async () => { const k = await newMemberKey(s.ch.id, account); await call("register_key", { channel: s.ch.id, pubkey: k.publicKey }); await reload(); }} />
            </div>
          </div>
        ))}
        {subs.length === 0 && <section className="sheet"><h2>No subscriptions yet</h2><p className="sub"><a href="#/">Find a creator</a> to follow.</p></section>}
        {signals.map((s) => (
          <FeedCard key={s.id} s={s} name={name(s.channel)} now={now} account={account} opened={opened[s.id]} live={prices[s.id] ?? null} />
        ))}
      </div>
      <div>
        <section className="sheet">
          <h2>Your subscriptions</h2>
          {subs.length === 0 && <p className="sub0">None.</p>}
          {subs.map((s) => (
            <div className="mem" key={s.ch.id}>
              <a href={`#/c/${s.ch.id}`}><b>{s.ch.name}</b></a>
              <span className={s.m.until_ms > now ? "sub0" : "loss"}>{s.m.until_ms > now ? `until ${when(s.m.until_ms)}` : `ended ${when(s.m.until_ms)}`} · <a href={`#/c/${s.ch.id}`}>renew</a></span>
            </div>
          ))}
        </section>
        <section className="sheet">
          <h2>Money back</h2>
          {refund.length === 0 ? (
            <p className="sub">Nothing to claim. When a creator's week isn't positive, the held half you paid for that week shows up here.</p>
          ) : refund.map((s) => (
            <div key={s.ch.id} style={{ marginTop: 10 }}>
              <p className="bignum">{near(s.claim[0])}</p>
              <p className="sub">{s.ch.name}: {s.claim[1].length} period{s.claim[1].length > 1 ? "s" : ""} weren't positive, so the held half you paid for {s.claim[1].length > 1 ? "them" : "it"} is yours.</p>
              <Act className="btn wide" label={`Claim ${near(s.claim[0])}`} run={async () => { await call("claim_refund", { channel: s.ch.id }); await reload(); }} />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function FeedCard({ s, name, now, account, opened, live }: { s: Signal; name: string; now: number; account: string; opened?: Opened | string; live: number | null }) {
  const sealed = isSealed(s);
  const body = s.body ?? (opened && typeof opened !== "string" ? opened.body : null);
  const head = (
    <div className="hd">
      <span><b>{name}</b> · {when(s.posted_at_ms)}</span>
      <span>{sealed ? (now < opensAt(s) ? <>public in <Countdown to={opensAt(s)} now={now} /></> : "opening…") : "ended"}</span>
    </div>
  );
  if (sealed) {
    const fresh = now - s.posted_at_ms < 3_600_000;
    return (
      <article className={`card ${fresh ? "fresh" : ""}`}>
        {fresh && <div className="tape" />}
        {head}
        <div className="bd">
          {body ? (
            <>
              <SignalFace b={body} validUntil={opensAt(s)} />
              <div className="live">
                {live != null && <span>Now <b>{price(sig(live))}</b>, {rangeState(body, live)}</span>}
                {typeof opened !== "string" && opened?.matches && <span className="verified">✓ Same signal that's locked on-chain</span>}
                <MarketLinks b={body} />
              </div>
            </>
          ) : typeof opened === "string" ? (
            <p className="sub0">{opened}</p>
          ) : s.wrapped_keys.some((w) => w.member === account) ? (
            <p className="sub0">Decrypting…</p>
          ) : (
            <p className="sub0">Posted before you subscribed or set up this browser. It opens for you {when(opensAt(s))}.</p>
          )}
        </div>
      </article>
    );
  }
  return (
    <article className="card">
      {head}
      <div className="bd ended">
        <div>
          {body ? <SignalFace b={body} size="m" /> : <p className="big">{s.outcome === "unrevealed" ? "Never opened" : "Invalid signal"}</p>}
          {s.fill_price && <div className="sub0 small">Filled {price(s.fill_price)}{s.exit_price ? ` → exit ${price(s.exit_price)}` : ""}{s.cost_bps != null ? ` · costs ${costPct(s.cost_bps)}` : ""}</div>}
        </div>
        <div className="r-col"><Outcome s={s} /><Result s={s} big /></div>
      </div>
    </article>
  );
}
