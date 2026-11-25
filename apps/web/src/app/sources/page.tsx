'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { ProfilePhoto, Thumbnail } from '@/components/ui/profile-photo';
import { useAuth } from '@/components/providers/AuthProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest } from '@/lib/saas-types';
import { usePolling } from '@/lib/use-polling';
import { humanize } from '@/lib/humanize';

interface SourceVideo {
  id: string;
  title: string;
  detectionStatus: string;
  clipJobId?: string;
  videoUrl?: string;
  thumbnailUrl?: string | null;
  creator?: { displayName: string; avatarUrl?: string | null };
}

export default function SourcesPage() {
  const { token } = useAuth();
  const [creators, setCreators] = useState<Array<{ id: string; displayName: string }>>([]);
  const [videos, setVideos] = useState<SourceVideo[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!token) return;
    let active = true;
    const loadVideos = () => void apiRequest<SourceVideo[]>('/api/v1/monitor/videos', { token }).then((result) => {
      if (active && result.ok && result.json.data) setVideos(result.json.data);
    }).catch(() => {});
    void apiRequest<typeof creators>('/api/v1/creators', { token }).then((result) => {
      if (active && result.ok && result.json.data) setCreators(result.json.data);
    }).catch(() => { if (active) setNotice('Could not load tagged creators.'); });
    loadVideos();
    return () => { active = false; };
  }, [token]);

  // Refresh only while a replay is being processed, and never in a hidden tab.
  const processing = videos.some((video) => ['DETECTED', 'PROCESSING', 'LIVE', 'FINALIZING'].includes(video.detectionStatus));
  usePolling(() => token && apiRequest<SourceVideo[]>('/api/v1/monitor/videos', { token }).then((result) => {
    if (result.ok && result.json.data) setVideos(result.json.data);
  }), 5000, processing);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    setNotice('');
    const fields = new FormData(event.currentTarget);
    try {
      const sourceId = fields.get('sourceId');
      let id = typeof sourceId === 'string' ? sourceId : '';
      if (!id) {
        const videoUrl = String(fields.get('videoUrl'));
        const url = new URL(videoUrl);
        const externalVideoId = url.searchParams.get('v') ??
          (url.hostname === 'youtu.be' || url.pathname.startsWith('/live/') ? url.pathname.split('/').at(-1) : null);
        if (!externalVideoId || !/^[\w-]{11}$/.test(externalVideoId)) throw new Error('Enter a YouTube replay URL.');
        const registered = await apiRequest<SourceVideo>('/api/v1/monitor/videos', {
          method: 'POST', token,
          body: { creatorId: fields.get('creatorId'), title: fields.get('title'), videoUrl, externalVideoId,
            publishedAt: new Date(String(fields.get('publishedAt'))).toISOString() },
        });
        if (!registered.ok || !registered.json.data) throw new Error('Could not register the replay for this creator.');
        id = registered.json.data.id;
      }
      const sourcePath = `/api/v1/monitor/videos/${id}`;
      const upload = await apiRequest<{ videoUploadUrl: string; transcriptUploadUrl: string }>(
        `${sourcePath}/source-upload`, { method: 'POST', token },
      );
      if (!upload.ok || !upload.json.data) throw new Error('Source upload is unavailable. Check storage or open the existing clip.');
      const media = fields.get('video');
      const transcript = fields.get('transcript');
      if (!(media instanceof File) || !media.size || media.size > 250 * 1024 * 1024 ||
        !(transcript instanceof File) || !transcript.size || transcript.size > 1024 * 1024) {
        throw new Error('Choose an MP4 up to 250 MiB and a timed transcript up to 1 MiB.');
      }
      const videoPut = await fetch(upload.json.data.videoUploadUrl, { method: 'PUT', body: media });
      if (!videoPut.ok) throw new Error('Video upload failed.');
      const transcriptPut = await fetch(upload.json.data.transcriptUploadUrl, { method: 'PUT', body: transcript });
      if (!transcriptPut.ok) throw new Error('Transcript upload failed.');
      const queued = await apiRequest(`${sourcePath}/queue`, { method: 'POST', token });
      if (!queued.ok) throw new Error(typeof queued.json.error === 'string' ? queued.json.error : 'Could not queue the clip.');
      setNotice('Source queued. Open the clip below when review is ready.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not queue the clip.');
    } finally {
      setBusy(false);
    }
  }

  const [detected, setDetected] = useState('');
  return (
    <AppShell title="Generate from Replay" subtitle="Upload source footage and its timed transcript for Clip Network to render." breadcrumb="OPERATIONS / REPLAYS">
      <form onSubmit={generate} className="grid max-w-2xl gap-4 rounded-lg border bg-card p-5">
        <label>Detected replay
          <select name="sourceId" value={detected} onChange={(event) => setDetected(event.target.value)} className="block w-full rounded border bg-background p-2">
            <option value="">Register a YouTube replay</option>
            {videos.filter((video) => !video.clipJobId).map((video) => <option key={video.id} value={video.id}>{video.title}</option>)}
          </select>
        </label>
        {!detected && <>
          <label>Tagged creator
            <select required name="creatorId" className="block w-full rounded border bg-background p-2">
              <option value="">Select a creator</option>
              {creators.map((creator) => <option key={creator.id} value={creator.id}>{creator.displayName}</option>)}
            </select>
          </label>
          <label>YouTube replay URL<Input required name="videoUrl" type="url" /></label>
          <label>Replay title<Input required name="title" /></label>
          <label>Replay date<Input required name="publishedAt" type="date" /></label>
        </>}
        <label>Source video<Input required name="video" type="file" accept="video/mp4,.mp4" /></label>
        <label>Timed transcript JSON<Input required name="transcript" type="file" accept="application/json,.json" /></label>
        <p className="text-sm text-muted-foreground">Cue times use the uploaded video clock. Include a highlight range to use specific cuts.</p>
        <Button disabled={busy} type="submit">{busy ? 'Uploading…' : 'Generate Clip'}</Button>
        <p role="status" className="text-sm">{notice}</p>
      </form>
      <h2 className="mb-2 mt-6 font-semibold">Replay jobs</h2>
      <ul className="grid gap-2">
        {videos.map((video) => <li key={video.id} className="flex items-center gap-3 rounded-md border border-border bg-card p-2 text-sm">
          <Thumbnail src={video.thumbnailUrl} className="h-12 w-20" />
          <div className="min-w-0 flex-1">
            {video.videoUrl
              ? <a href={video.videoUrl} target="_blank" rel="noreferrer" className="line-clamp-1 font-medium hover:text-primary">{video.title}</a>
              : <span className="line-clamp-1 font-medium">{video.title}</span>}
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              {video.creator && <><ProfilePhoto src={video.creator.avatarUrl} name={video.creator.displayName} size={16} />{video.creator.displayName} ·</>}
              <span>{humanize(video.detectionStatus)}</span>
            </div>
          </div>
          {video.clipJobId && <Link className="shrink-0 text-xs text-primary underline" href={`/clips/${video.clipJobId}`}>Open review</Link>}
        </li>)}
      </ul>
    </AppShell>
  );
}
