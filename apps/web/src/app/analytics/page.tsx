'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, describeChannelScan, type ChannelScanResult } from '@/lib/saas-types';

interface AnalyticsPayload {
  scope: string;
  disclaimer: string;
  totals: {
    detectedVideosCount: number;
    totalClips: number;
    compliancePassRate: number;
    approvalRate: number;
    publishedCount: number;
    publishSuccessRate: number;
    totalViews: number;
    totalLikes: number;
    totalComments: number;
    totalShares: number;
    avgCompletionRatePct: number;
    avgDurationMs: number;
  };
  timeSeries: Array<{
    label: string;
    views: number;
    likes: number;
    shares: number;
    completionRatePct: number;
  }>;
  platformBreakdown: Array<{
    platform: string;
    posts: number;
    views: number;
    likes: number;
    shares: number;
    engagementRatePct: number;
  }>;
  topPosts: Array<{
    postId: string;
    title: string;
    creatorName: string;
    platform: string;
    accountHandle: string;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    watchTimeAvgSec: number;
    completionRatePct: number;
    sourceMode: string;
    metricsError?: string | null;
  }>;
  insights: Array<{ title: string; detail: string; category: string }>;
}

export default function AnalyticsPage() {
  const { token, notify } = useAuth();
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<AnalyticsPayload>('/api/v1/analytics', { token });
    if (res.ok && res.json.data) setData(res.json.data);
    setLoadFailed(!res.ok || !res.json.data);
  }, [token]);

  // Opening the page shows stored numbers at once, then refreshes posts not checked in the last six
  // hours (the server reuses anything newer) and reloads.
  useEffect(() => {
    if (!token) return;
    let active = true;
    void load().then(() => apiRequest('/api/v1/analytics/sync-metrics', { method: 'POST', token }))
      .then((res) => { if (active && res.ok) return load(); })
      .catch(() => {});
    return () => { active = false; };
  }, [load, token]);

  async function syncMetrics() {
    if (!token) return;
    setBusy(true);
    const res = await apiRequest<{ syncedCount: number }>('/api/v1/analytics/sync-metrics', {
      method: 'POST',
      token,
    });
    setBusy(false);
    if (res.ok && res.json.data) {
      await load();
      notify(`Synced metrics for ${res.json.data.syncedCount} published post(s).`, 'success');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not sync metrics. Retry.', 'error');
    }
  }

  async function scanChannels() {
    if (!token) return;
    setBusy(true);
    const res = await apiRequest<ChannelScanResult>('/api/v1/monitor/scan', {
      method: 'POST',
      token,
      body: {},
    });
    setBusy(false);
    if (res.ok && res.json.data) {
      await load();
      notify(describeChannelScan(res.json.data), res.json.data.creatorsScanned ? 'success' : 'error');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not scan channels. Retry.', 'error');
    }
  }

  return (
    <AppShell
      title="Analytics & Post Insights"
      subtitle="Recharts performance telemetry from posted clips, channel monitoring, and compliance rates."
      breadcrumb="OBSERVABILITY / ANALYTICS"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={scanChannels} disabled={busy}>
            <Radio className="mr-1.5 h-3.5 w-3.5 text-primary" /> Scan Channels
          </Button>
          <Button size="sm" onClick={syncMetrics} disabled={busy}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> Sync Post Metrics
          </Button>
        </div>
      }
    >
      {loadFailed && (
        <div role="alert" className="mb-4 flex items-center gap-3 text-sm">
          <span>Could not load analytics.</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      {!data ? !loadFailed && (
        <p role="status" className="text-xs text-muted-foreground">Loading analytics…</p>
      ) : (
        <div className="space-y-6">
          <div className="rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
            <span>
              <strong className="text-foreground">Telemetry Mode:</strong> {data.disclaimer}
            </span>
            <Badge variant="outline" className="font-mono text-[10px]">{data.scope}</Badge>
          </div>

          {/* KPI Strip */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            {[
              { label: 'Total Views', value: data.totals.totalViews.toLocaleString() },
              { label: 'Total Likes', value: data.totals.totalLikes.toLocaleString() },
              { label: 'Total Shares', value: data.totals.totalShares.toLocaleString() },
              { label: 'Avg Completion', value: `${data.totals.avgCompletionRatePct}%` },
              { label: 'Published Posts', value: data.totals.publishedCount },
              { label: 'Compliance Pass', value: `${data.totals.compliancePassRate}%` },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-border bg-card p-4 space-y-1">
                <div className="text-[11px] text-muted-foreground">{m.label}</div>
                <div className="font-display text-xl font-semibold tabular-nums">{m.value}</div>
              </div>
            ))}
          </div>

          {/* Charts Row: AreaChart (Views & Likes) + BarChart (Platform Breakdown) */}
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7 rounded-lg border border-border bg-card p-5 space-y-3">
              <div className="text-sm font-display font-semibold">Views &amp; Likes Trajectory</div>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.timeSeries}>
                    <defs>
                      <linearGradient id="viewsArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#D4FF00" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#D4FF00" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                    <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        borderColor: 'hsl(var(--border))',
                        fontSize: '12px',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Area
                      type="monotone"
                      dataKey="views"
                      name="Views"
                      stroke="#D4FF00"
                      strokeWidth={2}
                      fill="url(#viewsArea)"
                    />
                    <Area
                      type="monotone"
                      dataKey="likes"
                      name="Likes"
                      stroke="#38BDF8"
                      strokeWidth={2}
                      fillOpacity={0.08}
                      fill="#38BDF8"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="lg:col-span-5 rounded-lg border border-border bg-card p-5 space-y-3">
              <div className="text-sm font-display font-semibold">Views by Publishing Platform</div>
              <div className="h-72 w-full">
                {data.platformBreakdown.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-xs text-muted-foreground border border-dashed border-border rounded">
                    Publish a clip to compare Instagram, TikTok, YouTube Shorts &amp; X performance.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.platformBreakdown}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="platform" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                      <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          borderColor: 'hsl(var(--border))',
                          fontSize: '12px',
                        }}
                      />
                      <Bar dataKey="views" name="Views" fill="#D4FF00" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="likes" name="Likes" fill="#38BDF8" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* Actionable Insights */}
          <div className="grid gap-4 md:grid-cols-3">
            {data.insights.map((ins) => (
              <div key={ins.title} className="rounded-lg border border-border bg-card p-5 space-y-1.5">
                <div className="font-mono text-[10px] text-primary">{ins.category}</div>
                <div className="font-display text-sm font-semibold">{ins.title}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">{ins.detail}</p>
              </div>
            ))}
          </div>

          {/* Top Published Posts Table */}
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="border-b border-border px-5 py-3.5 text-sm font-display font-semibold">
              Published Video Performance ({data.topPosts.length})
            </div>
            {data.topPosts.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground">
                No published videos with telemetry yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border font-mono text-muted-foreground">
                    <tr>
                      <th className="p-3.5">Clip Title</th>
                      <th className="p-3.5">Account</th>
                      <th className="p-3.5">Views</th>
                      <th className="p-3.5">Likes</th>
                      <th className="p-3.5">Shares</th>
                      <th className="p-3.5">Completion</th>
                      <th className="p-3.5">Source</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border tabular-nums">
                    {data.topPosts.map((p) => (
                      <tr key={p.postId}>
                        <td className="p-3.5 font-medium">{p.title}</td>
                        <td className="p-3.5 font-mono text-muted-foreground">
                          {p.accountHandle} ({p.platform})
                        </td>
                        <td className="p-3.5 font-mono font-semibold">{p.views.toLocaleString()}</td>
                        <td className="p-3.5 font-mono">{p.likes.toLocaleString()}</td>
                        <td className="p-3.5 font-mono">{p.shares.toLocaleString()}</td>
                        <td className="p-3.5 font-mono">{p.completionRatePct}%</td>
                        <td className="p-3.5">
                          <Badge variant="outline" className="font-mono text-[10px]" title={p.metricsError ?? undefined}>
                            {p.sourceMode === 'LIVE_PLATFORM_API' ? 'Platform data'
                              : p.sourceMode === 'SANDBOX_SIMULATED' ? 'Simulated (sandbox)'
                                : 'Awaiting platform data'}
                          </Badge>
                          {p.metricsError && <span className="mt-1 block text-[11px] text-muted-foreground">{p.metricsError}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
