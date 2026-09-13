// A compact usage glance for the Overview heading — opens the Usage view.
// Hidden entirely until the summary loads, and stays hidden if it can't.
import { useEffect, useState } from 'react';
import type { ModelNewsFeed, UsageSummary } from '../../usage/types.js';
import { apiFetch, responseJson } from '../apiFetch.js';
import { formatTokens, formatUsd } from './usageModel.js';

export function UsageStrip({ onOpen }: { onOpen: () => void }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [headline, setHeadline] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      apiFetch('/api/usage/summary').then((response) => responseJson<UsageSummary>(response))
        .then((next) => { if (!cancelled) setSummary(next); })
        .catch(() => undefined);
      apiFetch('/api/usage/news').then((response) => responseJson<ModelNewsFeed>(response))
        .then((feed) => {
          const latest = feed.items.find((item) => item.kind !== 'first-seen');
          if (!cancelled) setHeadline(latest?.title ?? null);
        })
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!summary) return null;
  const period = (id: string) => summary.periods.find((entry) => entry.period === id)?.current;
  const today = period('today');
  const week = period('week');
  const month = period('month');

  return (
    <button aria-label="Open usage" className="usage-strip" onClick={onOpen} type="button">
      <span className="usage-strip-stat"><small>Today</small><strong>{formatTokens(today?.totalTokens ?? 0)}</strong></span>
      <span className="usage-strip-stat"><small>This week</small><strong>{formatTokens(week?.totalTokens ?? 0)}</strong></span>
      <span className="usage-strip-stat"><small>Month est.</small><strong>{formatUsd(month?.costUsd ?? 0)}</strong></span>
      {summary.topModel && <span className="usage-strip-stat"><small>Top model · 30d</small><strong className="mono">{summary.topModel.model}</strong></span>}
      {headline && <span className="usage-strip-news" title={headline}><small>Model news</small><span>{headline}</span></span>}
      <span aria-hidden="true" className="usage-strip-go">Usage ›</span>
    </button>
  );
}
