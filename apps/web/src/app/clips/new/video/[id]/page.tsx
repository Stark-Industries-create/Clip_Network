'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { PlatformIcon, ProfilePhoto, Thumbnail } from '@/components/ui/profile-photo';
import { humanize } from '@/lib/humanize';
import { usePolling } from '@/lib/use-polling';
import { apiRequest } from '@/lib/saas-types';

type Details = {
  video: {
    id: string; title: string; videoUrl: string; thumbnailUrl: string | null; externalVideoId: string;
    detectionStatus: string; automationError: string | null; publishedAt: string; detectedAt: string; durationSec: number;
  };
  creator: { id: string; displayName: string; handle: string; platform: string; avatarUrl: string | null; channelUrl: string };
  embed: { kind: 'YOUTUBE' | 'TWITCH'; id: string } | null;
  stats: {
    source: string; views: number | null; likes: number | null; comments: number | null; durationSec: number | null;
    publishedAt: string | null; channelTitle: string | null; description: string | null;
  } | null;
  analysis: { transcriptSource?: string; recordingSec?: number; wallSec?: number; candidatesRefined?: number; rankedBy?: string };
  clips: { id: string; title: string; startSec: number; endSec: number; durationSec: number; executionStatus: string; approvalStatus: string; qualityIssue: string | null; complianceScore: number; posts: number }[];
  clipPerformance: { views: number; likes: number; comments: number; shares: number; postsTracked: number };
};

const number = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const ACTIVE = ['DETECTED', 'PROCESSING', 'LIVE', 'FINALIZING'];

function clock(totalSec: number) {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-lg font-semibold">{value}</div>
    </div>
  );
}

/** One detected recording: the platform's player, its public stats, and the clips cut from it. */
export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token, notify } = useAuth();
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState('');
  const [queuing, setQueuing] = useState(false);
  const [host, setHost] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<Details>(`/api/v1/monitor/videos/${id}/details`, { token });
    if (res.ok && res.json.data) setData(res.json.data);
    else setError(typeof res.json.error === 'string' ? res.json.error : 'Could not load this video.');
  }, [id, token]);

  useEffect(() => { setHost(window.location.hostname); void load(); }, [load]);
  usePolling(load, 10_000, Boolean(data && ACTIVE.includes(data.video.detectionStatus)));

  async function clipIt() {
    if (!token) return;
    setQueuing(true);
    const res = await apiRequest(`/api/v1/monitor/videos/${id}/clip`, { method: 'POST', token });
    setQueuing(false);
    if (res.ok) notify('Queued. Clips appear here when the worker finishes this video.', 'success');
    else notify(typeof res.json.error === 'string' ? res.json.error : 'Could not queue this video.', 'error');
    await load();
  }

  const stats = data?.stats;
  const duration = stats?.durationSec ?? (data?.video.durationSec || null);

  return (
    <AppShell
      title={data?.video.title ?? 'Video'}
      subtitle={data ? `${data.creator.displayName} · ${humanize(data.creator.platform)}` : undefined}
      breadcrumb="OPERATIONS / INGEST / VIDEO"
      actions={data && (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/clips/new/creator/${data.creator.id}`}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> {data.creator.displayName}</Link>
          </Button>
          {data.video.detectionStatus === 'SKIPPED' && data.clips.length === 0 && (
            <Button size="sm" disabled={queuing} onClick={() => void clipIt()}>
              <Scissors className="mr-1.5 h-3.5 w-3.5" /> {queuing ? 'Queuing…' : 'Find clips in this video'}
            </Button>
          )}
        </div>
      )}
    >
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!data && !error && <p role="status" className="text-xs text-muted-foreground">Loading video…</p>}
      {data && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-8">
            <div className="aspect-video overflow-hidden rounded-lg border border-border bg-black">
              {data.embed?.kind === 'YOUTUBE' ? (
                <iframe className="h-full w-full" title={data.video.title} loading="lazy"
                  src={`https://www.youtube-nocookie.com/embed/${data.embed.id}?rel=0`}
                  allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
              ) : data.embed?.kind === 'TWITCH' && host ? (
                <iframe className="h-full w-full" title={data.video.title} loading="lazy" allowFullScreen
                  src={`https://player.twitch.tv/?video=${data.embed.id}&parent=${encodeURIComponent(host)}&autoplay=false`} />
              ) : (
                <a href={data.video.videoUrl} target="_blank" rel="noreferrer" className="relative block h-full w-full">
                  <Thumbnail src={data.video.thumbnailUrl} className="h-full w-full rounded-none" />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm font-medium text-white">Watch on {humanize(data.creator.platform)}</span>
                </a>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <ProfilePhoto src={data.creator.avatarUrl} name={data.creator.displayName} size={36} />
                <div>
                  <div className="text-sm font-medium">{data.creator.displayName}</div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground"><PlatformIcon platform={data.creator.platform} /> @{data.creator.handle}</div>
                </div>
              </div>
              <a href={data.video.videoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Open on {humanize(data.creator.platform)} <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <section className="space-y-3">
              <h2 className="font-display text-sm font-semibold">Clips from this video ({data.clips.length})</h2>
              {data.clips.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                  {ACTIVE.includes(data.video.detectionStatus) ? 'The worker is finding moments in this video. Clips appear here when it finishes.'
                    : data.video.detectionStatus === 'SKIPPED' ? 'Only the newest video is clipped automatically. Use "Find clips in this video" to clip this one.'
                      : 'No clips were cut from this video.'}
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                  {data.clips.map((clip) => (
                    <li key={clip.id}>
                      <Link href={`/clips/${clip.id}`} className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs hover:bg-secondary/30">
                        <span className="font-mono text-muted-foreground">{clock(clip.startSec)}–{clock(clip.endSec)}</span>
                        <span className="min-w-0 flex-1 truncate">{clip.qualityIssue ?? `${Math.round(clip.durationSec)}s clip`}</span>
                        <Badge variant="outline">{humanize(clip.executionStatus === 'COMPLETED' ? clip.approvalStatus : clip.executionStatus)}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <aside className="space-y-5 lg:col-span-4">
            <section className="space-y-2">
              <h2 className="font-display text-sm font-semibold">Video stats</h2>
              {stats ? (
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Views" value={stats.views === null ? '—' : number.format(stats.views)} />
                  <Stat label="Likes" value={stats.likes === null ? '—' : number.format(stats.likes)} />
                  <Stat label="Comments" value={stats.comments === null ? '—' : number.format(stats.comments)} />
                  <Stat label="Length" value={duration ? clock(duration) : '—'} />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {data.creator.platform === 'YOUTUBE' ? 'YouTube did not return stats right now. Try again later.' : `${humanize(data.creator.platform)} does not publish stats for recordings.`}
                </p>
              )}
              <dl className="grid grid-cols-2 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Published</dt>
                <dd>{new Date(stats?.publishedAt ?? data.video.publishedAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">Found by Clip Network</dt>
                <dd>{new Date(data.video.detectedAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{data.video.detectionStatus === 'SKIPPED' ? 'Not clipped' : humanize(data.video.detectionStatus)}</dd>
              </dl>
              {stats?.source === 'YOUTUBE_PAGE' && stats.comments === null && (
                <p className="text-[11px] text-muted-foreground">Comment counts need a YouTube Data API key in Integrations.</p>
              )}
              {data.video.automationError && <p role="alert" className="text-xs text-destructive">{data.video.automationError}</p>}
            </section>

            {(data.analysis.recordingSec !== undefined || data.analysis.transcriptSource) && (
              <section className="space-y-2">
                <h2 className="font-display text-sm font-semibold">How it was clipped</h2>
                <dl className="grid grid-cols-2 gap-y-1 text-xs">
                  {data.analysis.transcriptSource && <><dt className="text-muted-foreground">Transcript from</dt><dd>{humanize(data.analysis.transcriptSource)}</dd></>}
                  {data.analysis.rankedBy && <><dt className="text-muted-foreground">Moments ranked by</dt><dd>{data.analysis.rankedBy === 'LLM' ? 'AI' : 'Rules'}</dd></>}
                  {data.analysis.recordingSec !== undefined && <><dt className="text-muted-foreground">Recording analyzed</dt><dd>{clock(data.analysis.recordingSec)}</dd></>}
                  {data.analysis.wallSec !== undefined && <><dt className="text-muted-foreground">Analysis time</dt><dd>{clock(data.analysis.wallSec)}</dd></>}
                </dl>
              </section>
            )}

            <section className="space-y-2">
              <h2 className="font-display text-sm font-semibold">Published clip performance</h2>
              {data.clipPerformance.postsTracked ? (
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Views" value={number.format(data.clipPerformance.views)} />
                  <Stat label="Likes" value={number.format(data.clipPerformance.likes)} />
                  <Stat label="Comments" value={number.format(data.clipPerformance.comments)} />
                  <Stat label="Shares" value={number.format(data.clipPerformance.shares)} />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No clips from this video have been published yet.</p>
              )}
            </section>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
