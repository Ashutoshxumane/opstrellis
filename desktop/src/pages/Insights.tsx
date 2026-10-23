import { useEffect, useState } from "react";
import { api, errMsg, useEvent, type Stats } from "../api";
import { CATEGORY_LABELS, Page, Section, fmtNum, localDate } from "../ui";
import { Stat } from "./Home";

const WEEKS = 26;

export default function Insights() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.getStats().then(setStats, (e) => setError(errMsg(e)));
  useEffect(() => void load(), []);
  useEvent("history-updated", load);

  if (error) return <Page title="Insights"><div className="error">{error}</div></Page>;
  if (!stats) return <Page title="Insights" />;

  const order = Object.keys(CATEGORY_LABELS);
  const cats = order.map((c) => stats.categories.find((x) => x.category === c) ?? { category: c, count: 0, words: 0 });
  const maxWords = Math.max(1, ...cats.map((c) => c.words));
  const totalCatWords = cats.reduce((a, c) => a + c.words, 0) || 1;
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

  return (
    <Page title="Insights" className="insights-page">
      <div className="card stat-strip">
        <Stat label="Words per minute" value={Math.round(stats.wpm)} />
        <Stat label="Total words" value={fmtNum(stats.totalWords)} />
        <Stat label="Dictations" value={fmtNum(stats.totalDictations)} />
        <Stat label="Fixes by cleanup" value={fmtNum(stats.fixes)} />
      </div>

      <Section title="Activity" aside={<span className="meta">Last six months</span>}>
        <div className="card activity">
          <Heatmap days={stats.days} />
          <dl className="streaks">
            <div><dt>Current streak</dt><dd>{days(stats.streak)}</dd></div>
            <div><dt>Longest streak</dt><dd>{days(stats.longestStreak)}</dd></div>
            <div><dt>Active days</dt><dd>{stats.days.filter((d) => d.words > 0).length}</dd></div>
          </dl>
        </div>
      </Section>

      <Section title="Where you dictate" aside={<span className="meta">Share of words</span>}>
        <div className="card bars">
          {cats.map((c) => (
            <div key={c.category} className="bar-row">
              <div className="bar-label">{CATEGORY_LABELS[c.category]}</div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(c.words / maxWords) * 100}%` }} /></div>
              <div className="bar-value">{Math.round((c.words / totalCatWords) * 100)}%</div>
            </div>
          ))}
        </div>
      </Section>
    </Page>
  );
}

function Heatmap({ days }: { days: Stats["days"] }) {
  const words = new Map(days.map((d) => [d.date, d.words]));
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7); // Sunday, WEEKS-1 weeks ago
  const max = Math.max(1, ...days.map((d) => d.words));

  const cells = [];
  const months: { col: number; label: string }[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d.getDate() === 1 || i === 0) months.push({ col: Math.floor(i / 7), label: d.toLocaleDateString([], { month: "short" }) });
    if (d > today) { cells.push(<span key={i} className="cell future" />); continue; }
    const key = localDate(d);
    const w = words.get(key) ?? 0;
    const level = w === 0 ? 0 : Math.min(4, Math.ceil((w / max) * 4));
    cells.push(<span key={i} className={`cell l${level}`} title={`${key}: ${w} words`} />);
  }
  return (
    <div className="heatmap-wrap">
      <div className="heatmap-months">
        {months.map((m, i) => (
          <span key={i} style={{ gridColumn: m.col + 1 }}>{i < months.length - 1 && months[i + 1].col - m.col < 3 ? "" : m.label}</span>
        ))}
      </div>
      <div className="heatmap">{cells}</div>
      <div className="heatmap-legend">Less {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`cell l${l}`} />)} More</div>
    </div>
  );
}
