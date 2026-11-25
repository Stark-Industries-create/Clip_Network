'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Play, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type Creator } from '@/lib/saas-types';
import { humanize } from '@/lib/humanize';

const CAPTION_PRESETS = ['HIGH_ENERGY', 'BOLD_CREATOR', 'CLEAN_MINIMAL', 'PODCAST_PREMIUM'] as const;
const LAYOUT_PRESETS = ['SPLIT_FACECAM_BOTTOM', 'CENTER_CROP_9_16'] as const;

export default function NewClipPage() {
  const router = useRouter();
  const { token, workspace, refreshSession, notify } = useAuth();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorId, setCreatorId] = useState('');
  // Empty by default: sample values here were easy to submit by mistake as a real clip.
  const [sourceUrl, setSourceUrl] = useState('');
  const [title, setTitle] = useState('');
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(30);
  const [transcriptText, setTranscriptText] = useState('');
  const [captionStyle, setCaptionStyle] = useState<(typeof CAPTION_PRESETS)[number]>('HIGH_ENERGY');
  const [layout, setLayout] = useState<(typeof LAYOUT_PRESETS)[number]>('SPLIT_FACECAM_BOTTOM');
  const [enableSfx, setEnableSfx] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<Creator[]>('/api/v1/creators', { token });
    if (res.ok && res.json.data) {
      setCreators(res.json.data);
      if (res.json.data[0] && !creatorId) setCreatorId(res.json.data[0].id);
    }
  }, [token, creatorId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedCreator = creators.find((c) => c.id === creatorId);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !creatorId) {
      notify('Select or add a creator first.', 'error');
      return;
    }
    setBusy(true);
    const res = await apiRequest<{ clip: { id: string } }>('/api/v1/clips/ingest', {
      method: 'POST',
      token,
      body: {
        creatorId,
        sourceUrl,
        title,
        startSec,
        endSec,
        transcriptText,
        captionStyle,
        layout,
        enableSfx,
      },
    });
    setBusy(false);
    if (res.ok && res.json.data) {
      await refreshSession();
      notify('Clip created. Opening Review Studio.', 'success');
      router.push(`/clips/${res.json.data.clip.id}`);
    } else if (res.status === 402) {
      notify('Monthly clip quota exhausted. Upgrade your plan in Billing.', 'error');
      router.push('/settings/billing');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Ingest failed.', 'error');
    }
  }

  return (
    <AppShell
      title="Cut a Clip by Hand"
      subtitle="Run speech-aligned captions, procedural SFX, compliance scoring, and routing."
      breadcrumb="OPERATIONS / INGEST / MANUAL CLIP"
    >
      <div className="grid gap-6 lg:grid-cols-12">
        <form
          onSubmit={handleGenerate}
          className="lg:col-span-8 rounded-lg border border-border bg-card p-6 space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Source Creator</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={creatorId}
                onChange={(e) => setCreatorId(e.target.value)}
              >
                {creators.length === 0 && <option value="">No creators tagged yet</option>}
                {creators.map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName} (@{c.handle} • {c.platform})</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Stream / VOD URL</Label>
              <Input required type="url" placeholder="https://www.youtube.com/watch?v=…" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Clip Hook / Title</Label>
            <Input required placeholder="What happens in this moment" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Start Time (sec)</Label>
              <Input type="number" min={0} value={startSec} onChange={(e) => setStartSec(Number(e.target.value))} />
            </div>
            <div className="space-y-1">
              <Label>End Time (sec)</Label>
              <Input type="number" min={1} value={endSec} onChange={(e) => setEndSec(Number(e.target.value))} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Transcript Excerpt (Speech Alignment &amp; Compliance Check)</Label>
            <textarea
              required
              rows={3}
              placeholder="What is said during the clip, used for captions and campaign compliance"
              value={transcriptText}
              onChange={(e) => setTranscriptText(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Caption Style Preset</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs font-mono"
                value={captionStyle}
                onChange={(e) => setCaptionStyle(e.target.value as (typeof CAPTION_PRESETS)[number])}
              >
                {CAPTION_PRESETS.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Vertical Framing Layout</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs font-mono"
                value={layout}
                onChange={(e) => setLayout(e.target.value as (typeof LAYOUT_PRESETS)[number])}
              >
                {LAYOUT_PRESETS.map((l) => <option key={l} value={l}>{humanize(l)}</option>)}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={enableSfx} onCheckedChange={setEnableSfx} />
              <Volume2 className="h-3.5 w-3.5 text-primary" />
              <span>Procedural SFX Cues (WHOOSH / POP / BOOM)</span>
            </label>
            <Button type="submit" disabled={busy || !creatorId}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              {busy ? 'Generating...' : 'Generate Clips'}
            </Button>
          </div>
        </form>

        {/* Pre-Execution Summary & Quota Impact */}
        <div className="lg:col-span-4 rounded-lg border border-border bg-card p-5 space-y-4 h-fit text-xs">
          <h2 className="font-display text-sm font-semibold">Pre-Execution Summary</h2>
          <div className="space-y-2 border-y border-border py-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Creator</span>
              <span className="font-medium">{selectedCreator ? selectedCreator.displayName : 'None'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Required Topics</span>
              <span className="font-mono">{selectedCreator?.requiredTopics.join(', ') || 'Any'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Quota Impact</span>
              <span className="font-mono">
                +1 clip ({(workspace?.clipsUsedThisPeriod ?? 0) + 1}/{workspace?.monthlyClipLimit ?? 10})
              </span>
            </div>
          </div>
          {creators.length === 0 && (
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href="/creators">Tag Your First Creator →</Link>
            </Button>
          )}
        </div>
      </div>
    </AppShell>
  );
}
