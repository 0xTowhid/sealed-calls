import { allSignals, channelTags, listChannels } from "../near";
import { creatorRecord, useLoad } from "../data";
import { channelPath, day, pct } from "../format";
import { KindTags, kindsShown } from "../ui";

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
    <section className="sheet">
      <div className="owner-head">
        <div>
          <div className="sub0 small">{creator} · creator since {day(data.since)}</div>
          <h1 className="display m">{own ? "My channels" : `${creator}'s channels`}</h1>
        </div>
        {own && <a className="btn" href="#/desk/new">+ New channel</a>}
      </div>
      <div className="chlist">
        {data.per.map(({ ch, signals, rec }) => (
          <a className="chrow" key={ch.id} href={channelPath(ch, data.channels)}>
            <div>
              <b>{ch.name}</b><KindTags kinds={kindsShown(data.tags.get(ch.id) ?? [], signals)} />
              <div className="small sub0 url0">{window.location.host}{window.location.pathname}{channelPath(ch, data.channels)}</div>
            </div>
            <div className="n"><b>{rec.signals}</b><span>signals</span></div>
            <div className="n"><b className={cls(rec.score_bps)}>{pct(rec.score_bps)}</b><span>score</span></div>
            <div className="n"><b>{rec.periodsSettled ? `${rec.periodsEarned} of ${rec.periodsSettled}` : "—"}</b><span>days earned</span></div>
          </a>
        ))}
        <div className="chrow total">
          <div><b>All channels together</b></div>
          <div className="n"><b>{data.rec.signals}</b></div>
          <div className="n"><b className={cls(data.rec.score_bps)}>{pct(data.rec.score_bps)}</b></div>
          <div className="n"><b>{data.rec.periodsSettled ? `${data.rec.periodsEarned} of ${data.rec.periodsSettled}` : "—"}</b></div>
        </div>
      </div>
      <p className="fine">A creator's combined record is shown on every one of their channels. A new channel never hides an old one, and nothing can be removed from either.</p>
    </section>
  );
}
