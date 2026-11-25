'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, RotateCcw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { API_BASE, apiRequest, type ClipJob, type PublishPost } from '@/lib/saas-types';
import { usePolling } from '@/lib/use-polling';
import { humanize } from '@/lib/humanize';

interface ClipDetail extends ClipJob {
  assScript: string;
  transcript: string;
  automationSourceKey?: string | null;
  sfxCues: Array<{ presetId?: string; atSec?: number }>;
  publishPosts: PublishPost[];
}

interface MediaUrlInfo {
  storageMode: string;
  objectKey: string;
  signedUrl: string | null;
}

export default function ClipReviewStudioPage() {
  const { id } = useParams<{ id: string }>();
  const { token, notify } = useAuth();
  const [clip, setClip] = useState<ClipDetail | null>(null);
  const [mediaInfo, setMediaInfo] = useState<MediaUrlInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [captionTrack, setCaptionTrack] = useState<{ url: string; lang: string } | null>(null);

  // Load the captions as a text track. The request needs the user's token, so the file is fetched
  // here and handed to the player as a same-origin blob URL.
  const signedUrl = mediaInfo?.signedUrl;
  useEffect(() => {
    if (!token || !id || !signedUrl) return;
    let url: string | null = null;
    let active = true;
    void fetch(`${API_BASE}/api/v1/clips/${id}/captions.vtt`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (!active || !res.ok) return;
        const lang = res.headers.get('X-Caption-Language') ?? 'und';
        url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/vtt' }));
        if (active) setCaptionTrack({ url, lang });
      })
      .catch(() => {});
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setCaptionTrack(null);
    };
  }, [token, id, signedUrl]);

  const load = useCallback(async () => {
    if (!token || !id) return;
    const [cRes, mRes] = await Promise.all([
      apiRequest<ClipDetail>(`/api/v1/clips/${id}`, { token }),
      apiRequest<MediaUrlInfo>(`/api/v1/clips/${id}/media-url`, { token }),
    ]);
    if (cRes.ok && cRes.json.data) setClip(cRes.json.data);
    if (mRes.ok && mRes.json.data) setMediaInfo(mRes.json.data);
    setLoadError(cRes.ok && cRes.json.data ? null : (
      cRes.status === 404 ? 'Clip not found in this workspace.' : 'Could not load clip details.'
    ));
    setMediaError(!mRes.ok || !mRes.json.data);
  }, [token, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const processing = clip?.executionStatus === 'QUEUED' || clip?.executionStatus === 'RUNNING';
  usePolling(load, 3000, processing);

  async function decide(decision: 'APPROVED' | 'REJECTED') {
    if (!token || !id) return;
    setBusy(true);
    const res = await apiRequest(`/api/v1/clips/${id}/decision`, {
      method: 'POST',
      token,
      body: { decision },
    });
    setBusy(false);
    setConfirmReject(false);
    if (res.ok) {
      await load();
      notify(decision === 'APPROVED' && clip && clip.publishPosts.length === 0
        ? 'Clip approved. It has no destination yet: add a routing rule for this creator to publish it.'
        : `Clip ${decision.toLowerCase()}.`, decision === 'APPROVED' && clip?.publishPosts.length === 0 ? 'info' : 'success');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Action failed.', 'error');
    }
  }

  async function lifecycleAction(action: 'cancel' | 'retry') {
    if (!token || !id) return;
    setBusy(true);
    const res = await apiRequest(`/api/v1/clips/${id}/${action}`, { method: 'POST', token });
    setBusy(false);
    if (res.ok) {
      await load();
      notify(res.status === 202 ? 'Clip queued for rendering.' : `Execution ${action === 'cancel' ? 'cancelled' : 'retried'}.`, 'info');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Action failed.', 'error');
    }
  }

  async function uploadAndRender() {
    if (!token || !sourceFile) return;
    setBusy(true);
    try {
      const signed = await apiRequest<{ uploadUrl: string | null }>(`/api/v1/clips/${id}/upload-url`, {
        method: 'POST', token, body: { ext: 'mp4' },
      });
      if (!signed.ok || !signed.json.data?.uploadUrl) throw new Error('Media storage is unavailable.');
      const upload = await fetch(signed.json.data.uploadUrl, {
        method: 'PUT', body: sourceFile, headers: { 'Content-Type': 'video/mp4' },
      });
      if (!upload.ok) throw new Error('Source video upload failed.');
      const render = await apiRequest(`/api/v1/clips/${id}/retry`, { method: 'POST', token });
      await load();
      if (!render.ok) throw new Error(typeof render.json.error === 'string' ? render.json.error : 'Render failed.');
      notify('Clip rendered.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Render failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title={clip?.title ?? 'Clip Review Studio'}
      subtitle={clip ? `${clip.creator?.displayName ?? 'Creator'} • ${clip.durationSec}s • ${humanize(clip.layout)}` : undefined}
      breadcrumb="OPERATIONS / REVIEW STUDIO"
      actions={
        clip && (
          <div className="flex items-center gap-2">
            {clip.executionStatus === 'COMPLETED' && clip.approvalStatus === 'AWAITING_APPROVAL' && clip.compliancePassed &&
              (mediaInfo?.storageMode === 'LOCAL_SANDBOX' || mediaInfo?.signedUrl) && (
              <>
                <Button size="sm" onClick={() => decide('APPROVED')} disabled={busy}>
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Approve &amp; Release
                </Button>
                {!confirmReject ? (
                  <Button size="sm" variant="outline" onClick={() => setConfirmReject(true)} disabled={busy}>
                    <XCircle className="mr-1.5 h-3.5 w-3.5" /> Reject
                  </Button>
                ) : (
                  <Button size="sm" variant="destructive" onClick={() => decide('REJECTED')} disabled={busy}>
                    Confirm Reject
                  </Button>
                )}
              </>
            )}
            {clip.executionStatus === 'CANCELLED' || (clip.automationSourceKey &&
              (clip.executionStatus === 'FAILED' || clip.executionStatus === 'TIMED_OUT')) ? (
              <Button size="sm" variant="outline" onClick={() => lifecycleAction('retry')} disabled={busy}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
              </Button>
            ) : clip.executionStatus === 'PENDING' || clip.executionStatus === 'QUEUED' ? (
              // Only waiting jobs can be cancelled; finished or running ones offer nothing to cancel.
              <Button size="sm" variant="ghost" onClick={() => lifecycleAction('cancel')} disabled={busy}>
                Cancel Job
              </Button>
            ) : null}
          </div>
        )
      }
    >
      {loadError && (
        <div role="alert" className="mb-4 flex items-center gap-3 text-sm">
          <span>{loadError}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      {!clip ? !loadError && (
        <p className="text-xs text-muted-foreground">Loading clip details...</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Left: Vertical Preview Surface, ASS Subtitles & Engine Logs */}
          <div className="lg:col-span-7 space-y-6">
            {mediaError && (
              <div role="alert" className="flex items-center gap-3 text-sm">
                <span>Could not load clip media.</span>
                <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
              </div>
            )}
            {mediaInfo?.signedUrl && (
              <video className="max-h-[70vh] w-full rounded-lg bg-black" controls playsInline src={mediaInfo.signedUrl}>
                {/* Off by default: captions are already burned into the video. The track gives screen
                    readers, transcript tools and viewers who prefer player-styled captions the same text. */}
                {captionTrack && (
                  <track kind="captions" src={captionTrack.url} srcLang={captionTrack.lang} label="Captions (text)" />
                )}
              </video>
            )}
            {!clip.automationSourceKey && mediaInfo?.storageMode === 'S3_LIVE' && !mediaInfo.signedUrl && (
              <div className="space-y-3 rounded-lg border border-border bg-card p-4">
                <label className="block text-sm" htmlFor="source-mp4">Source MP4 (up to 250 MB)</label>
                <input id="source-mp4" type="file" accept="video/mp4,.mp4" disabled={busy}
                  onChange={(event) => setSourceFile(event.target.files?.[0] ?? null)} />
                <Button disabled={busy || !sourceFile || sourceFile.size > 250 * 1024 * 1024}
                  onClick={() => void uploadAndRender()}>Upload and render</Button>
              </div>
            )}
            <div className="rounded-lg border border-border bg-card p-5 space-y-3 text-sm">
              <h2 className="text-xs font-medium text-muted-foreground">Transcript</h2>
              <p className="leading-relaxed">{clip.transcript}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                <a className="truncate text-primary underline" href={clip.sourceUrl} target="_blank" rel="noreferrer">Source video</a>
                <span>{clip.durationSec}s • {humanize(clip.captionStyle)} captions</span>
                <span>Approval: {humanize(clip.approvalStatus)}</span>
              </div>
            </div>
          </div>

          {/* Right: Compliance Inspector & Publishing Destinations */}
          <div className="lg:col-span-5 space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                  {clip.compliancePassed ? (
                    <ShieldCheck className="h-4 w-4 text-primary" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-destructive" />
                  )}
                  Compliance Evaluation
                </h2>
                <Badge variant={clip.compliancePassed ? 'default' : 'destructive'} className="font-mono">
                  {clip.complianceScore} / 100
                </Badge>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Matched Topics</span>
                  <span className="font-mono">
                    {clip.complianceReport.matchedTopics.join(', ') || 'None'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Disqualifiers</span>
                  <span className="font-mono">
                    {clip.complianceReport.disqualifiersTriggered.join(', ') || '0'}
                  </span>
                </div>
                {clip.complianceReport.reasons.length > 0 && (
                  <ul className="list-disc pl-4 text-destructive pt-1 space-y-1">
                    {clip.complianceReport.reasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-5 space-y-3">
              <h2 className="font-display text-sm font-semibold">
                Routed Destinations ({clip.publishPosts.length})
              </h2>
              {clip.publishPosts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No publishing destinations routed, so this clip will not be posted. Create a routing rule for this creator in{' '}
                  <a className="text-primary underline" href="/routes">Routing Rules</a>.
                </p>
              ) : (
                <div className="space-y-2">
                  {clip.publishPosts.map((p) => (
                    <div key={p.id} className="rounded border border-border p-3 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{p.socialAccount?.accountHandle}</span>
                        <Badge variant={p.status.startsWith('PUBLISHED') ? 'default' : 'outline'}>
                          {humanize(p.status)}
                        </Badge>
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {humanize(p.platform)} • {humanize(p.executionMode)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
