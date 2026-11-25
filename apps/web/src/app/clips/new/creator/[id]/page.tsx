'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { PlatformIcon, ProfilePhoto, Thumbnail } from '@/components/ui/profile-photo';
import { humanize } from '@/lib/humanize';
import { usePolling } from '@/lib/use-polling';
import { apiRequest, describeChannelScan, type ChannelScanResult, type Creator } from '@/lib/saas-types';

type DetectedVideo = {
  id: string; title: string; thumbnailUrl: string | null; detectionStatus: string; publishedAt: string;
  automationError: string | null; clips: { id: string; executionStatus: string }[];
};

const ACTIVE = ['DETECTED', 'PROCESSING', 'LIVE', 'FINALIZING'];

/** Every recording detected on one creator's channel, newest first. */
export default function CreatorVideosPage() {
  const { id } = useParams<{ id: string }>();
  const { token, notify } = useAuth();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [videos, setVideos] = useState<DetectedVideo[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const loadVideos = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<DetectedVideo[]>(`/api/v1/monitor/videos?creatorId=${encodeURIComponent(id)}`, { token });
    setVideos(res.ok && res.json.data ? res.json.data : []);
  }, [id, token]);

  useEffect(() => {
    if (!token) return;
    void apiRequest<Creator>(`/api/v1/creators/${id}`, { token }).then((res) => { if (res.ok && res.json.data) setCreator(res.json.data); });
    void loadVideos();
  }, [id, loadVideos, token]);

  usePolling(loadVideos, 8000, Boolean(videos?.some((v) => ACTIVE.includes(v.detectionStatus))));

  async function scan() {
    if (!token) return;
    setScanning(true);
    const res = await apiRequest<ChannelScanResult>('/api/v1/monitor/scan', { method: 'POST', token, body: { creatorId: id } });
    setScanning(false);
    if (res.ok && res.json.data) notify(describeChannelScan(res.json.data), res.json.data.creatorsScanned ? 'success' : 'error');
    else notify('Channel check failed. Try again.', 'error');
    await loadVideos();
  }

  return (
    <AppShell
      title={creator?.displayName ?? 'Creator videos'}
      subtitle="Every recording found on this channel. Open one for its stats, player and clips."
      breadcrumb="OPERATIONS / INGEST / CREATOR"
      actions={
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" asChild><Link href="/clips/new"><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> All creators</Link></Button>
          <Button size="sm" variant="outline" disabled={scanning} onClick={() => void scan()}>
            <Radio className="mr-1.5 h-3.5 w-3.5" /> {scanning ? 'Checking…' : 'Check for new videos'}
          </Button>
        </div>
      }
    >
      {creator && (
        <div className="mb-6 flex items-center gap-4">
          <ProfilePhoto src={creator.avatarUrl} name={creator.displayName} size={48} />
          <div className="min-w-0">
            <div className="font-display text-base font-semibold">{creator.displayName}</div>
            <a href={creator.channelUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
              <PlatformIcon platform={creator.platform} /> @{creator.handle}
            </a>
          </div>
        </div>
      )}

      {videos === null ? (
        <p role="status" className="text-xs text-muted-foreground">Loading videos…</p>
      ) : videos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center space-y-2">
          <p className="text-sm font-medium">No videos found yet</p>
          <p className="text-xs text-muted-foreground">Check the channel now, or wait for the next automatic check.</p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {videos.map((v) => {
            const rendered = v.clips.filter((c) => c.executionStatus === 'COMPLETED').length;
            return (
              <li key={v.id}>
                <Link href={`/clips/new/video/${v.id}`} className="group block overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/60">
                  <div className="relative aspect-video bg-muted">
                    <Thumbnail src={v.thumbnailUrl} className="h-full w-full rounded-none" />
                    <Badge variant={ACTIVE.includes(v.detectionStatus) ? 'default' : 'secondary'} className="absolute left-2 top-2 text-[10px]">
                      {v.detectionStatus === 'SKIPPED' ? 'Not clipped' : humanize(v.detectionStatus)}
                    </Badge>
                  </div>
                  <div className="space-y-1 p-3">
                    <div className="line-clamp-2 text-sm font-medium group-hover:text-primary">{v.title}</div>
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>{new Date(v.publishedAt).toLocaleDateString()}</span>
                      <span>{rendered} {rendered === 1 ? 'clip' : 'clips'}</span>
                    </div>
                    {v.automationError && <div className="truncate text-[11px] text-destructive">{v.automationError}</div>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
