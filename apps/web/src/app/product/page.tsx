'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PublicFooter, PublicNavbar } from '@/components/layout/PublicChrome';

const PIPELINE_STAGES = [
  {
    step: '01',
    name: 'Creator Source',
    tech: 'CreatorAccount (Twitch / YouTube / Kick)',
    detail:
      'Store channel URLs, handles, default 9:16 framing mode (SPLIT_FACECAM_BOTTOM or CENTER_CROP_9_16), caption preset, SFX policy, and campaign rules per tenant workspace.',
  },
  {
    step: '02',
    name: 'Stream Moments',
    tech: 'POST /api/v1/clips/ingest',
    detail:
      'Accept stream/VOD URLs, start/end timestamps, hook titles, and transcript excerpts via Studio UI or automated X-Api-Key webhooks. Enforces workspace monthly clip quota (HTTP 402 when exhausted).',
  },
  {
    step: '03',
    name: 'Clip Engine',
    tech: '@clip-network/clip-engine',
    detail:
      'Tracks full execution lifecycle (QUEUED -> RUNNING -> COMPLETED / CANCELLED / FAILED) with timestamped execution logs and millisecond duration telemetry.',
  },
  {
    step: '04',
    name: 'Captions & Procedural SFX',
    tech: 'alignTranscriptToSpeechWindows + buildWordSyncedAss + buildAutoSfxCuesForCuts',
    detail:
      'Aligns transcript words to speech windows, generates word-synced ASS subtitle tracks across 4 creator styles, and schedules procedural WHOOSH/POP/RISER/BOOM/CHIME/GLITCH cues.',
  },
  {
    step: '05',
    name: 'Compliance Evaluation',
    tech: 'evaluateClipCompliance()',
    detail:
      'Scores clips 0–100 against required campaign topics, banned keywords, generic clickbait filters, and zero-logo rules. Failed clips are marked DISQUALIFIED and blocked from publishing.',
  },
  {
    step: '06',
    name: 'Human Approval Gate',
    tech: 'POST /api/v1/clips/:clipId/decision',
    detail:
      'Compliant clips default to AWAITING_APPROVAL. Workspace reviewers inspect captions, logs, and compliance reports in the Review Studio before approving or rejecting.',
  },
  {
    step: '07',
    name: 'Social Distribution',
    tech: 'CreatorRouteRule + AES-256-GCM Token Vault',
    detail:
      'Routes approved clips to linked Instagram Reels, TikTok, YouTube Shorts, and X accounts. Auto-publishing is strictly opt-in per social account.',
  },
  {
    step: '08',
    name: 'Publishing Results',
    tech: 'PublishPost (Idempotent Delivery)',
    detail:
      'Every post carries a unique key, so retries never upload the same clip twice, and each post shows exactly where and when it went live.',
  },
];

export default function ProductPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicNavbar />
      <main className="mx-auto max-w-[1100px] px-4 py-16 sm:px-6 space-y-14">
        <div className="max-w-2xl space-y-3">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            System Architecture
          </div>
          <h1 className="font-display text-4xl sm:text-5xl font-semibold tracking-tight">
            How Clip Network turns live streams into governed distribution.
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every stage is persisted in your tenant-isolated workspace database, audited, and
            accessible via both the web studio and REST API.
          </p>
        </div>

        <div className="divide-y divide-border border-y border-border">
          {PIPELINE_STAGES.map((stage) => (
            <div key={stage.step} className="grid gap-4 py-7 md:grid-cols-12">
              <div className="md:col-span-4 space-y-1">
                <div className="font-mono text-xs text-primary">STAGE {stage.step}</div>
                <h2 className="font-display text-xl font-semibold">{stage.name}</h2>
              </div>
              <div className="md:col-span-8 space-y-2">
                <div className="font-mono text-xs text-muted-foreground">{stage.tech}</div>
                <p className="text-sm leading-relaxed text-muted-foreground">{stage.detail}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-6">
          <div>
            <h3 className="font-display text-lg font-semibold">Ready to test the pipeline?</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Create a free workspace and run your first compliant clip in under two minutes.
            </p>
          </div>
          <Button asChild>
            <Link href="/register">
              Create Free Workspace <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
