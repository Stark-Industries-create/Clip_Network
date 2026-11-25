'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckSquare, Plus, Radio, RefreshCw, Send, Users } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { usePolling } from '@/lib/use-polling';
import { apiRequest, describeChannelScan, type ChannelScanResult, type ClipJob, type PublishPost } from '@/lib/saas-types';
import { humanize } from '@/lib/humanize';

interface DetectedVideo {
  id: string;
  title: string;
  videoUrl: string;
  detectionStatus: string;
  clips?: {
    id: string;
    executionStatus: string;
    approvalStatus?: string;
    startSec: number;
    endSec?: number;
    contentType?: string;
    qualityIssue?: string | null;
    errorMessage?: string | null;
    publishPosts?: { id: string; platform: string; status: string; errorMessage?: string | null }[];
  }[];
  automationError?: string | null;
  clipJobId?: string | null;
  detectedAt: string;
  creator?: { id: string; displayName: string; handle: string; platform: string; sourceAccessError?: string | null };
}

interface AnalyticsOverview {
  scope: string;
  totals: {
    detectedVideosCount: number;
    totalClips: number;
    publishedCount: number;
    totalViews: number;
    totalLikes: number;
    avgCompletionRatePct: number;
    pendingCount: number;
    failedCount: number;
  };
  timeSeries: Array<{ label: string; views: number; likes: number; shares: number }>;
  insights: Array<{ title: string; detail: string; category: string }>;
}

export default function DashboardPage() {
  const { token, workspace, refreshSession, notify } = useAuth();
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [videos, setVideos] = useState<DetectedVideo[]>([]);
  const [clips, setClips] = useState<ClipJob[]>([]);
  const [posts, setPosts] = useState<PublishPost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const [aRes, vRes, cRes, pRes] = await Promise.all([
      apiRequest<AnalyticsOverview>('/api/v1/analytics', { token }),
      apiRequest<DetectedVideo[]>('/api/v1/monitor/videos', { token }),
      apiRequest<ClipJob[]>('/api/v1/clips', { token }),
      apiRequest<PublishPost[]>('/api/v1/publish-queue', { token }),
    ]);
    if (aRes.ok && aRes.json.data) setAnalytics(aRes.json.data);
    if (vRes.ok && vRes.json.data) setVideos(vRes.json.data);
    if (cRes.ok && cRes.json.data) setClips(cRes.json.data);
    if (pRes.ok && pRes.json.data) setPosts(pRes.json.data);
    setLoadFailed([aRes, vRes, cRes, pRes].some(result => !result.ok));
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh only while something is being detected, analyzed or rendered (and never in a hidden tab).
  const working = videos.some((v) => ['LIVE', 'FINALIZING', 'PROCESSING'].includes(v.detectionStatus) ||
    (v.detectionStatus === 'DETECTED' && !v.automationError)) ||
    clips.some((c) => c.executionStatus === 'QUEUED' || c.executionStatus === 'RUNNING');
  // Light refresh: only the lists that change while work runs, not the analytics rollup.
  usePolling(async () => {
    if (!token) return;
    const [vRes, cRes] = await Promise.all([
      apiRequest<DetectedVideo[]>('/api/v1/monitor/videos', { token }),
      apiRequest<ClipJob[]>('/api/v1/clips', { token }),
    ]);
    if (vRes.ok && vRes.json.data) setVideos(vRes.json.data);
    if (cRes.ok && cRes.json.data) setClips(cRes.json.data);
  }, 10_000, working);

  const [failingChannels, setFailingChannels] = useState<Array<{ id: string; displayName: string; sourceAccessError: string }>>([]);
  useEffect(() => {
    if (!token) return;
    void apiRequest<Array<{ id: string; displayName: string; sourceAccessError?: string | null }>>('/api/v1/creators', { token })
      .then((res) => {
        if (res.ok && res.json.data) {
          setFailingChannels(res.json.data.flatMap((c) => (c.sourceAccessError ? [{ id: c.id, displayName: c.displayName, sourceAccessError: c.sourceAccessError }] : [])));
        }
      }).catch(() => {});
  }, [token, videos]);

  async function retryRecording(id: string) {
    const res = await apiRequest('/api/v1/monitor/videos/' + id + '/queue', { method: 'POST', token });
    notify(res.ok ? 'Recording queued for analysis.' : (
      typeof res.json.error === 'string' ? res.json.error : 'Check the recording connection and retry.'
    ), res.ok ? 'success' : 'error');
    await load();
  }

  async function retryChannel(creatorId: string) {
    if (!token) return;
    const res = await apiRequest<ChannelScanResult>('/api/v1/monitor/scan', { method: 'POST', token, body: { creatorId } });
    notify(res.ok && res.json.data ? describeChannelScan(res.json.data) : 'Could not check this channel.', res.ok ? 'success' : 'error');
    await load();
  }

  async function handleScanChannels() {
    if (!token) return;
    setScanning(true);
    const res = await apiRequest<ChannelScanResult>('/api/v1/monitor/scan', {
      method: 'POST',
      token,
      body: {},
    });
    setScanning(false);
    if (res.ok && res.json.data) {
      await refreshSession();
      await load();
      notify(describeChannelScan(res.json.data), res.json.data.creatorsScanned ? 'success' : 'error');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not scan channels. Retry.', 'error');
    }
  }

  return (
    <AppShell
      title="Operations Dashboard"
      subtitle={`Auto-monitor creator uploads, execute clipping, publish, and track insights for ${workspace?.name ?? ''}`}
      breadcrumb="WORKSPACE / DASHBOARD"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleScanChannels} disabled={scanning}>
            {scanning ? (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Radio className="mr-1.5 h-3.5 w-3.5 text-primary" />
            )}
            {scanning ? 'Scanning...' : 'Scan Channels'}
          </Button>
          <Button size="sm" asChild>
            <Link href="/clips/new">
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Ingest Clip
            </Link>
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {loadFailed && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-border bg-card p-3 text-sm">
            <span>Some dashboard data could not load.</span>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        )}
        {/* Primary KPI Row */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: 'Detected Uploads',
              value: analytics?.totals.detectedVideosCount ?? 0,
              sub: 'Monitored creator channels',
            },
            {
              label: 'Clips Executed',
              value: analytics?.totals.totalClips ?? clips.length,
              sub: `${analytics?.totals.pendingCount ?? 0} awaiting approval`,
            },
            {
              label: 'Published Posts',
              value: analytics?.totals.publishedCount ?? 0,
              sub: `${posts.length} total routed`,
            },
            {
              label: 'Tracked Post Views',
              value: (analytics?.totals.totalViews ?? 0).toLocaleString(),
              sub: `${analytics?.totals.avgCompletionRatePct ?? 0}% avg completion`,
            },
          ].map((k) => (
            <div key={k.label} className="rounded-lg border border-border bg-card p-5 space-y-1">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className="font-display text-2xl font-semibold tabular-nums">{k.value}</div>
              <div className="text-[11px] font-mono text-muted-foreground">{k.sub}</div>
            </div>
          ))}
        </div>

        {/* Recharts Post Performance + Actionable Insights */}
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 rounded-lg border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-sm font-semibold">Posted Video Views &amp; Engagement</h2>
                <p className="text-[11px] text-muted-foreground font-mono">
                  {analytics?.scope === 'LIVE_PLATFORM_METRICS' ? 'Platform data'
                    : analytics?.scope === 'MIXED_TELEMETRY' ? 'Platform data and sandbox simulation'
                      : 'Sandbox simulation'}
                </p>
              </div>
              <Link href="/analytics" className="text-xs text-primary hover:underline flex items-center gap-1">
                Full insights <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="h-56 w-full">
              {(analytics?.timeSeries ?? []).length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground border border-dashed border-border rounded">
                  Click &ldquo;Scan Channels&rdquo; to detect uploads, clip, publish, and chart post telemetry.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics?.timeSeries ?? []}>
                    <defs>
                      <linearGradient id="dashViewsGrad" x1="0" y1="0" x2="0" y2="1">
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
                    <Area
                      type="monotone"
                      dataKey="views"
                      stroke="#D4FF00"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#dashViewsGrad)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="lg:col-span-5 rounded-lg border border-border bg-card p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold">Automated Post Insights</h2>
            <div className="space-y-2.5">
              {(analytics?.insights ?? []).map((ins) => (
                <div key={ins.title} className="rounded-md border border-border bg-background/60 p-3 space-y-1">
                  <div className="font-mono text-[10px] text-primary">{ins.category}</div>
                  <div className="text-xs font-semibold">{ins.title}</div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{ins.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Detected Channel Uploads Feed + Quick Actions */}
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-8 rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <h2 className="font-display text-sm font-semibold">
                Auto-Detected Channel Videos ({videos.length})
              </h2>
              <Link href="/sources" className="text-xs text-primary hover:underline">Generate from Replay</Link>
              <button
                type="button"
                onClick={handleScanChannels}
                className="text-xs text-primary hover:underline"
              >
                Scan for new uploads
              </button>
            </div>
            {failingChannels.length > 0 && (
              <div role="alert" className="border-b border-border bg-destructive/10 px-5 py-3 text-xs space-y-1">
                {failingChannels.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span><strong>{c.displayName}:</strong> {c.sourceAccessError}</span>
                    <Link href={`/creators/${c.id}`} className="text-primary underline">Fix channel</Link>
                  </div>
                ))}
              </div>
            )}
            {videos.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <p className="text-sm font-medium">No channel uploads scanned yet</p>
                <p className="text-xs text-muted-foreground">
                  Add a creator channel and click &ldquo;Scan Channels&rdquo; to detect latest videos and trigger automated clipping.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {videos.slice(0, 6).map((v) => (
                  <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{v.title}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {v.creator?.displayName} ({v.creator?.platform}) • Detected {new Date(v.detectedAt).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={v.detectionStatus === 'CLIPPED' ? 'default' : 'outline'}>
                        {humanize(v.detectionStatus)}
                      </Badge>
                      {v.automationError && (<>
                        <span role="status">{v.automationError}</span>
                        <Button size="sm" variant="outline" onClick={() => void retryRecording(v.id)}>Retry recording</Button>
                      </>)}
                      {v.creator?.sourceAccessError && (<>
                        <span role="status" className="text-destructive">{v.creator.sourceAccessError}</span>
                        <Button size="sm" variant="outline" onClick={() => void retryChannel(v.creator!.id)}>Retry channel</Button>
                        <Button size="sm" variant="ghost" asChild><Link href="/creators">Reconnect</Link></Button>
                      </>)}
                      {v.clips?.map(clip => (
                        <div key={clip.id} className="flex flex-wrap items-center gap-1">
                          <Button size="sm" variant="ghost" asChild>
                            <Link href={`/clips/${clip.id}`}>
                              {Math.floor(clip.startSec)}s{clip.contentType ? ` · ${clip.contentType.toLowerCase()}` : ''} · {clip.approvalStatus === 'NEEDS_REVIEW' ? 'needs review' : clip.executionStatus}
                            </Link>
                          </Button>
                          {(clip.qualityIssue || clip.errorMessage) && <span className="text-muted-foreground">{clip.errorMessage ?? clip.qualityIssue}</span>}
                          {clip.publishPosts?.map(post => (
                            <Badge key={post.id} variant={post.status.startsWith('PUBLISHED') ? 'default' : post.status === 'FAILED' ? 'destructive' : 'outline'}
                              title={post.errorMessage ?? undefined}>
                              {post.platform} {post.status.toLowerCase().replace(/_/g, ' ')}
                            </Badge>
                          ))}
                        </div>
                      ))}
                      {!v.clips?.length && v.clipJobId && (
                        <Button size="sm" variant="ghost" asChild>
                          <Link href={`/clips/${v.clipJobId}`}>Review →</Link>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-4 space-y-3">
            {[
              { href: '/creators', label: 'Creator Channels', desc: 'Manage monitored streams', icon: Users },
              { href: '/approvals', label: 'Approval Queue', desc: `${analytics?.totals.pendingCount ?? 0} pending review`, icon: CheckSquare },
              { href: '/publishing', label: 'Publishing Queue', desc: `${posts.length} routed posts`, icon: Send },
            ].map((q) => (
              <Link
                key={q.href}
                href={q.href}
                className="rounded-lg border border-border bg-card p-4 hover:border-primary/60 transition-colors flex items-center justify-between"
              >
                <div>
                  <div className="text-xs font-medium">{q.label}</div>
                  <div className="text-[11px] text-muted-foreground">{q.desc}</div>
                </div>
                <q.icon className="h-4 w-4 text-primary" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
