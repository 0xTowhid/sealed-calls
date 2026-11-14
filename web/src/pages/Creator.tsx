import { allSignals, channelTags, listChannels } from "../near";
import { creatorRecord, useLoad } from "../data";
import { channelPath, day, pct } from "../format";
import { Avatar, Info, KindTags, kindsShown } from "../ui";

/** A creator's page: every channel they run and their combined record. */
export function CreatorPage({ creator, account }: { creator: string; account: string | null }) {
  const { data, error } = useLoad(async () => {
    const channels = await listChannels();
    const mine = channels.filter((c) => c.creator === creator);
    const [rec, tags] = await Promise.all([creatorRecord(creator, channels, (ch) => allSignals(ch.id, ch.signal_count)), channelTags(mine.map((c) => c.id))]);
    return { channels, ...rec, tags: new Map(mine.map((c, i) => [c.id, tags[i] ?? []])) };
  }, [creator], 30_000, `creator:${creator}`);
  if (error) return <div className="notice err">{error}</div>;
  if (!data) return <p className="empty">Reading {creator}'s channels…</p>;
  const own = account === creator;
  const cls = (b: number | null) => ((b ?? 0) > 0 ? "gain" : (b ?? 0) < 0 ? "loss" : "");
  return (
    <>
      <div className="owner-head" style={{ marginBottom: 18 }}>
        <div className="prof-top">
          <Avatar id={creator} size={52} />
          <div>
            <h1 className="page-h" style={{ margin: 0 }}>{own ? "My channels" : creator}</h1>
            <div className="sub0 small">{own ? `${creator} · ` : ""}trading since {day(data.since)}</div>
          </div>
        </div>
        {own && <a className="btn" href="#/desk/new">+ New channel</a>}
      </div>
      <div className="stats3">
        <div><b className={`num ${cls(data.rec.score_bps)}`}>{pct(data.rec.score_bps)}</b><span>score, all channels</span></div>
        <div><b className="num">{data.rec.signals}</b><span>calls</span></div>
        <div><b className="num">{data.rec.periodsSettled ? `${data.rec.periodsEarned} / ${data.rec.periodsSettled}` : "—"}</b><span>days paid</span></div>
      </div>
      <h2 className="sec-h">Channels<Info tip="One record across all channels: a new channel never hides an old one, and nothing can be removed from either." /></h2>
      <section className="panel">
        <ol className="clist plain">
          {data.per.map(({ ch, signals, rec }) => (
            <li key={ch.id}>
              <a href={channelPath(ch, data.channels)}>
                <span className="who"><span><b>{ch.name}<KindTags kinds={kindsShown(data.tags.get(ch.id) ?? [], signals)} /></b><small>{rec.signals ? `${rec.signals} call${rec.signals === 1 ? "" : "s"}` : "no calls yet"}{rec.periodsSettled ? ` · ${rec.periodsEarned} of ${rec.periodsSettled} days paid` : ""}</small></span></span>
                <span className={`score ${cls(rec.score_bps) || "ink3"}`}>{pct(rec.score_bps)}</span>
                <span className="chev" aria-hidden>›</span>
              </a>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
