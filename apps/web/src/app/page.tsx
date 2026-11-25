'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Film,
  GitBranch,
  Send,
  ShieldCheck,
  Sliders,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PublicFooter, PublicNavbar } from '@/components/layout/PublicChrome';
import { useAuth } from '@/components/providers/AuthProvider';

const WORKFLOW_STEPS = [
  {
    num: '01',
    title: 'Connect creators',
    desc: 'Tag Twitch, YouTube, and Kick channels with default framing, caption presets, and SFX rules.',
  },
  {
    num: '02',
    title: 'Define campaign rules',
    desc: 'Set required topics, banned keywords, and zero-logo enforcement per creator workspace.',
  },
  {
    num: '03',
    title: 'Generate clips',
    desc: 'Run the FFmpeg-backed engine for speech-aligned ASS captions, procedural SFX, and 9:16 layout.',
  },
  {
    num: '04',
    title: 'Review and approve',
    desc: 'Inspect compliance scores, execution logs, and captions inside the Review Studio before release.',
  },
  {
    num: '05',
    title: 'Distribute everywhere',
    desc: 'Route approved clips idempotently to linked Instagram, TikTok, YouTube Shorts, and X accounts.',
  },
];

const FAQS = [
  {
    q: 'How does Clip Network work?',
    a: 'You tag source creator channels, define compliance rules and routing targets, and ingest stream moments. The engine aligns captions to speech windows, generates procedural SFX cues, evaluates compliance, and queues approved clips for linked social accounts.',
  },
  {
    q: 'Which creator platforms are supported?',
    a: 'Source creator channels support Twitch, YouTube, and Kick. Publishing destinations support Instagram Reels, TikTok, YouTube Shorts, and X.',
  },
  {
    q: 'How are clips generated?',
    a: 'The core engine aligns transcripts to detected speech windows, compiles word-synced ASS subtitles across four caption presets, synthesizes procedural SFX cues, and outputs structured clip jobs with full execution logs.',
  },
  {
    q: 'Can I review clips before publishing?',
    a: 'Yes. Human approval is enforced by default on every linked social account. Clips stay in AWAITING_APPROVAL until an authorized workspace member approves them.',
  },
  {
    q: 'Does automatic publishing require connected social accounts?',
    a: 'Yes. Auto-publishing is strictly opt-in per linked social account and only triggers when a clip passes the creator compliance score threshold. You connect each account by signing in on the platform itself, and you can revoke access at any time.',
  },
  {
    q: 'How does compliance scoring work?',
    a: 'Every clip is evaluated by the deterministic shared compliance engine against required campaign topics, banned keywords, generic clickbait patterns, and zero-logo rules. Failed clips are disqualified and blocked from publishing.',
  },
  {
    q: 'What happens when my monthly quota is exhausted?',
    a: 'The API enforces workspace quotas server-side and returns HTTP 402 QUOTA_EXCEEDED before starting new ingest jobs. You can upgrade your plan anytime in Billing without losing existing clips or rules.',
  },
  {
    q: 'Can I cancel my subscription?',
    a: 'Yes. Workspace admins and owners can cancel immediately from Settings → Billing. The workspace reverts cleanly to the Free tier quota.',
  },
  {
    q: 'Does the platform support agencies?',
    a: 'Yes. Every workspace is tenant-isolated with role-based access control (OWNER, ADMIN, MEMBER, VIEWER), multiple creator routing rules, API keys, and audit logging.',
  },
];

export default function LandingPage() {
  const { plans } = useAuth();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicNavbar />

      <main>
        {/* SECTION 2: HERO + REAL PRODUCT PIPELINE VISUALIZATION */}
        <section className="border-b border-border">
          <div className="mx-auto max-w-[1280px] px-4 py-16 sm:px-6 lg:py-24">
            <div className="grid gap-12 lg:grid-cols-12 lg:items-center">
              <div className="lg:col-span-6 space-y-6">
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  <span>Creator-Content Distribution Operating System</span>
                </div>

                <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl lg:text-[54px] leading-[1.05]">
                  One stream. Infinite shorts. Zero distribution chaos.
                </h1>

                <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
                  Turn creator streams into compliant short-form content and distribute approved
                  clips across every major social platform from one workspace.
                </p>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <Button size="lg" className="h-11 px-6 font-medium" asChild>
                    <Link href="/register">
                      Start Clipping Free <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                  <Button size="lg" variant="outline" className="h-11 px-6" asChild>
                    <Link href="/product">Explore the Platform</Link>
                  </Button>
                </div>

                <div className="grid grid-cols-3 gap-4 border-t border-border pt-6 text-xs">
                  <div>
                    <div className="font-mono font-semibold text-foreground">4 Presets</div>
                    <div className="text-muted-foreground mt-0.5">Word-synced ASS captions</div>
                  </div>
                  <div>
                    <div className="font-mono font-semibold text-foreground">6 SFX Cues</div>
                    <div className="text-muted-foreground mt-0.5">Procedural audio accents</div>
                  </div>
                  <div>
                    <div className="font-mono font-semibold text-foreground">Default Gate</div>
                    <div className="text-muted-foreground mt-0.5">Human approval enforced</div>
                  </div>
                </div>
              </div>

              {/* Authentic Product Pipeline Representation */}
              <div className="lg:col-span-6">
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-[11px] font-mono text-muted-foreground">
                    <span>clip-engine / pipeline-inspector</span>
                    <span className="text-foreground">status: READY</span>
                  </div>

                  <div className="grid sm:grid-cols-12 divide-y sm:divide-y-0 sm:divide-x divide-border">
                    {/* Left: Vertical 9:16 Clip Surface */}
                    <div className="sm:col-span-5 p-4 flex flex-col justify-between bg-background/60">
                      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                        <span>9:16 VERTICAL</span>
                        <span>00:22s</span>
                      </div>
                      <div className="my-6 space-y-3">
                        <div className="rounded border border-border bg-card p-3 text-center space-y-1">
                          <div className="text-[10px] font-mono uppercase text-muted-foreground">
                            Gameplay / Main Frame
                          </div>
                          <div className="h-12 rounded bg-secondary/70 flex items-center justify-center text-[11px] font-mono text-muted-foreground">
                            1080 × 1220 crop
                          </div>
                        </div>
                        <div className="rounded border border-primary/50 bg-background px-2.5 py-2 text-center">
                          <span className="font-display text-xs font-bold tracking-wide uppercase">
                            &ldquo;GTA 6 <span className="text-primary">MARATHON</span> TONIGHT&rdquo;
                          </span>
                          <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                            HIGH_ENERGY • speech-aligned
                          </div>
                        </div>
                        <div className="rounded border border-border bg-card p-2 text-center">
                          <div className="text-[10px] font-mono uppercase text-muted-foreground">
                            Split Facecam Crop
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                        <span>SFX: WHOOSH + POP</span>
                        <span>0 LOGOS</span>
                      </div>
                    </div>

                    {/* Right: Compliance, Approval & Destinations */}
                    <div className="sm:col-span-7 p-4 space-y-4">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium">Campaign Compliance</span>
                          <Badge className="font-mono text-[10px]">100 / 100 PASS</Badge>
                        </div>
                        <div className="space-y-1 text-[11px] text-muted-foreground">
                          <div className="flex items-center justify-between">
                            <span>Required topic match</span>
                            <span className="font-mono text-foreground">GTA, marathon</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span>Banned keywords</span>
                            <span className="font-mono text-foreground">0 detected</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span>Zero-logo policy</span>
                            <span className="font-mono text-foreground">Enforced</span>
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-border pt-3 space-y-2">
                        <div className="text-xs font-medium">Approval &amp; Distribution</div>
                        <div className="space-y-1.5 text-[11px]">
                          {[
                            { acct: '@agency.reels', plat: 'Instagram Reels', mode: 'Human Approval Gate' },
                            { acct: '@agency.tiktok', plat: 'TikTok', mode: 'Opt-in Auto-Publish' },
                            { acct: '@agency.shorts', plat: 'YouTube Shorts', mode: 'Human Approval Gate' },
                          ].map((d) => (
                            <div
                              key={d.acct}
                              className="flex items-center justify-between rounded border border-border px-2.5 py-1.5 bg-background/50"
                            >
                              <div>
                                <div className="font-medium text-foreground">{d.acct}</div>
                                <div className="text-[10px] text-muted-foreground">{d.plat}</div>
                              </div>
                              <span className="font-mono text-[10px] text-muted-foreground">{d.mode}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 3: PLATFORM SUPPORT (SOURCE VS DESTINATION) */}
        <section className="border-b border-border bg-card/40">
          <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6">
            <div className="grid gap-6 md:grid-cols-2 md:divide-x divide-border">
              <div className="space-y-2.5">
                <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  Creator Source Channels
                </div>
                <div className="flex flex-wrap gap-2">
                  {['Twitch', 'YouTube', 'Kick'].map((p) => (
                    <span
                      key={p}
                      className="rounded border border-border bg-background px-3 py-1.5 text-xs font-medium"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              <div className="md:pl-8 space-y-2.5">
                <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  Publishing destinations
                </div>
                <div className="flex flex-wrap gap-2">
                  {['Instagram Reels', 'TikTok', 'YouTube Shorts', 'X'].map((p) => (
                    <span
                      key={p}
                      className="rounded border border-border bg-background px-3 py-1.5 text-xs font-medium"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 4: PROBLEM AND SOLUTION */}
        <section className="border-b border-border">
          <div className="mx-auto max-w-[1280px] px-4 py-20 sm:px-6 space-y-12">
            <div className="max-w-2xl space-y-3">
              <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Why Clip Network Exists
              </div>
              <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
                Clipping is easy. Managing distribution is not.
              </h2>
            </div>

            <div className="divide-y divide-border border-y border-border">
              {[
                {
                  problem: 'Manual clipping workflows',
                  issue:
                    'Downloading VODs, re-timing subtitles by hand, adding SFX, and exporting separate files for every account wastes hours per stream.',
                  solution:
                    'Ingest once. The engine aligns transcripts to speech windows, compiles ASS captions, schedules procedural SFX, and tracks execution logs automatically.',
                },
                {
                  problem: 'Campaign compliance mistakes',
                  issue:
                    'A single off-topic clip, banned keyword, or accidental watermark can disqualify an entire sponsored creator campaign.',
                  solution:
                    'Every clip is scored deterministically against required topics, banned keywords, clickbait filters, and zero-logo rules before it reaches any queue.',
                },
                {
                  problem: 'Fragmented publishing operations',
                  issue:
                    'Agencies juggle spreadsheets, shared logins, and duplicate uploads across dozens of fan and clipping pages.',
                  solution:
                    'Centralize routing rules per creator, store tokens encrypted with AES-256-GCM, and publish idempotently behind a workspace-scoped approval gate.',
                },
              ].map((row) => (
                <div key={row.problem} className="grid gap-6 py-8 md:grid-cols-12">
                  <div className="md:col-span-4">
                    <h3 className="font-display text-lg font-semibold">{row.problem}</h3>
                  </div>
                  <div className="md:col-span-4 text-sm text-muted-foreground leading-relaxed">
                    <div className="text-[11px] font-mono uppercase text-destructive mb-1">Bottleneck</div>
                    {row.issue}
                  </div>
                  <div className="md:col-span-4 text-sm leading-relaxed">
                    <div className="text-[11px] font-mono uppercase text-primary mb-1">Clip Network</div>
                    {row.solution}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SECTION 5: 5-STEP PRODUCT WORKFLOW */}
        <section id="how-it-works" className="border-b border-border bg-card/30">
          <div className="mx-auto max-w-[1280px] px-4 py-20 sm:px-6 space-y-12">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div className="space-y-2 max-w-xl">
                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Operational Pipeline
                </div>
                <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
                  Five deterministic stages from VOD to feed.
                </h2>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/product">Read full architecture →</Link>
              </Button>
            </div>

            <div className="grid gap-px bg-border border border-border md:grid-cols-5">
              {WORKFLOW_STEPS.map((s) => (
                <div key={s.num} className="bg-background p-6 space-y-3">
                  <div className="font-mono text-xs text-primary">{s.num}</div>
                  <h3 className="font-display text-base font-semibold">{s.title}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SECTION 6: DIFFERENTIATED CORE FEATURES */}
        <section id="features" className="border-b border-border">
          <div className="mx-auto max-w-[1280px] px-4 py-20 sm:px-6 space-y-12">
            <div className="max-w-2xl space-y-2">
              <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Platform Capabilities
              </div>
              <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
                Engineered for clipping teams, not novelty demos.
              </h2>
            </div>

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="lg:col-span-7 rounded-lg border border-border bg-card p-6 sm:p-8 flex flex-col justify-between space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                    <Film className="h-3.5 w-3.5 text-primary" />
                    <span>SPEECH-ALIGNED CAPTIONS &amp; VERTICAL FRAMING</span>
                  </div>
                  <h3 className="font-display text-2xl font-semibold">
                    Subtitles locked to actual speaker cadence.
                  </h3>
                  <p className="text-sm text-muted-foreground max-w-xl">
                    Choose between <code className="font-mono text-foreground">HIGH_ENERGY</code>,{' '}
                    <code className="font-mono text-foreground">BOLD_CREATOR</code>,{' '}
                    <code className="font-mono text-foreground">CLEAN_MINIMAL</code>, and{' '}
                    <code className="font-mono text-foreground">PODCAST_PREMIUM</code> presets with
                    split-facecam or center-crop 9:16 layouts.
                  </p>
                </div>
                <div className="rounded border border-border bg-background p-4 font-mono text-[11px] text-muted-foreground space-y-1">
                  <div>[Dialogue: 0:00:00.10 -&gt; 0:00:01.42] We are live on the GTA 6 marathon</div>
                  <div>[Dialogue: 0:00:01.48 -&gt; 0:00:02.95] tonight and chat is going wild!</div>
                </div>
              </div>

              <div className="lg:col-span-5 rounded-lg border border-border bg-card p-6 sm:p-8 space-y-5">
                <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                  <Volume2 className="h-3.5 w-3.5 text-primary" />
                  <span>PROCEDURAL SFX ENGINE</span>
                </div>
                <h3 className="font-display text-2xl font-semibold">
                  Cut-synced sound design with zero external stock packs.
                </h3>
                <p className="text-sm text-muted-foreground">
                  Automatically places <code className="font-mono text-foreground">WHOOSH</code>,{' '}
                  <code className="font-mono text-foreground">POP</code>,{' '}
                  <code className="font-mono text-foreground">RISER</code>,{' '}
                  <code className="font-mono text-foreground">BOOM</code>,{' '}
                  <code className="font-mono text-foreground">CHIME</code>, and{' '}
                  <code className="font-mono text-foreground">GLITCH</code> cues on scene cuts.
                </p>
                <div className="flex flex-wrap gap-1.5 pt-2">
                  {['WHOOSH', 'POP', 'RISER', 'BOOM', 'CHIME', 'GLITCH'].map((sfx) => (
                    <span
                      key={sfx}
                      className="rounded border border-border bg-background px-2.5 py-1 font-mono text-[11px]"
                    >
                      {sfx}
                    </span>
                  ))}
                </div>
              </div>

              <div className="lg:col-span-4 rounded-lg border border-border bg-card p-6 space-y-3">
                <Sliders className="h-4 w-4 text-primary" />
                <h3 className="font-display text-lg font-semibold">Creator Management</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Maintain per-creator channel metadata, default layouts, caption styles, and
                  campaign requirements isolated by workspace.
                </p>
              </div>

              <div className="lg:col-span-4 rounded-lg border border-border bg-card p-6 space-y-3">
                <GitBranch className="h-4 w-4 text-primary" />
                <h3 className="font-display text-lg font-semibold">Multi-Platform Routing</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Map any creator to one or dozens of clipping accounts with minimum compliance
                  thresholds, custom hashtags, and caption templates.
                </p>
              </div>

              <div className="lg:col-span-4 rounded-lg border border-border bg-card p-6 space-y-3">
                <Send className="h-4 w-4 text-primary" />
                <h3 className="font-display text-lg font-semibold">Execution Monitoring</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Inspect timestamped engine logs, execution durations, idempotency keys, and
                  cancel or retry jobs without duplicate publishing.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 7: APPROVAL & COMPLIANCE DIFFERENTIATOR */}
        <section className="border-b border-border bg-card/30">
          <div className="mx-auto max-w-[1280px] px-4 py-20 sm:px-6">
            <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
              <div className="lg:col-span-6 space-y-4">
                <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-primary">
                  <ShieldCheck className="h-4 w-4" />
                  <span>Governance &amp; Brand Safety</span>
                </div>
                <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
                  Automation without losing control.
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Brand campaigns and creator networks cannot afford unvetted uploads. Clip Network
                  combines deterministic rule checks with a strict human approval gate by default.
                </p>
                <ul className="space-y-2.5 pt-2 text-sm">
                  {[
                    'Required topic verification against transcript and hook',
                    'Banned keyword & generic clickbait disqualifiers',
                    'Zero-logo enforcement policy across rendered clips',
                    'Human approval required by default; auto-publish is strictly opt-in per account',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="lg:col-span-6 rounded-lg border border-border bg-background p-6 space-y-4">
                <div className="text-xs font-mono uppercase text-muted-foreground">
                  Approval Gate State Machine
                </div>
                <div className="space-y-3 text-xs">
                  <div className="flex items-center justify-between rounded border border-border p-3">
                    <span className="font-mono">1. evaluateClipCompliance()</span>
                    <Badge variant="outline">Score &gt;= 70 &amp; 0 disqualifiers</Badge>
                  </div>
                  <div className="flex items-center justify-between rounded border border-border p-3">
                    <span className="font-mono">2. ClipJob.approvalStatus</span>
                    <Badge variant="secondary">AWAITING_APPROVAL (default)</Badge>
                  </div>
                  <div className="flex items-center justify-between rounded border border-primary/60 bg-primary/5 p-3">
                    <span className="font-mono">3. Reviewer Decision / Opt-in Auto</span>
                    <Badge>APPROVED → Publish Queue</Badge>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 8: USE CASES */}
        <section className="border-b border-border">
          <div className="mx-auto max-w-[1280px] px-4 py-20 sm:px-6 space-y-10">
            <h2 className="font-display text-3xl font-semibold tracking-tight">
              Built for every layer of the clipping economy.
            </h2>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  role: 'Solo Clippers',
                  value: 'Turn long streams into captioned, SFX-enhanced shorts across fan pages without manual editing bottlenecks.',
                },
                {
                  role: 'Creator Agencies',
                  value: 'Operate isolated workspaces with RBAC, multi-creator routing rules, and fast batch review queues.',
                },
                {
                  role: 'Campaign Managers',
                  value: 'Enforce sponsor talking points, banned keywords, and zero-logo policies automatically before clips publish.',
                },
                {
                  role: 'Social Media Teams',
                  value: 'Keep final editorial sign-off in one approval queue with idempotent publishing and full audit logs.',
                },
              ].map((u) => (
                <div key={u.role} className="border-t-2 border-border pt-4 space-y-2">
                  <h3 className="font-display text-base font-semibold">{u.role}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">{u.value}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SECTION 9: LIVE PRICING PREVIEW (FROM BACKEND SAAS_PLANS) */}
        <section className="border-b border-border bg-card/30">
          <div className="mx-auto max-w-[1280px] px-4 py-20 sm:px-6 space-y-10">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div className="space-y-2">
                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Pricing
                </div>
                <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
                  Predictable quotas. Server-enforced entitlements.
                </h2>
              </div>
              <Button variant="outline" asChild>
                <Link href="/pricing">Compare Plans</Link>
              </Button>
            </div>

            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
              {plans.map((p) => (
                <div
                  key={p.id}
                  className={`rounded-lg border p-6 flex flex-col justify-between space-y-6 ${
                    p.highlighted
                      ? 'border-primary bg-background'
                      : 'border-border bg-card'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-display text-base font-semibold">{p.name}</span>
                      {p.highlighted && <Badge>Recommended</Badge>}
                    </div>
                    <div className="tabular-nums">
                      <span className="font-display text-3xl font-bold">${p.priceMonthlyUsd}</span>
                      <span className="text-xs text-muted-foreground"> / month</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{p.tagline}</p>
                    <div className="border-t border-border pt-3 space-y-1.5 text-xs font-mono">
                      <div>{p.monthlyClipLimit.toLocaleString()} clips / month</div>
                      <div>{p.maxCreators} creators • {p.maxSocialAccounts} social accounts</div>
                      <div>{p.apiKeysAllowed} API key{p.apiKeysAllowed === 1 ? '' : 's'}</div>
                    </div>
                    <ul className="space-y-1.5 pt-2 text-xs text-muted-foreground">
                      {p.features.map((f) => (
                        <li key={f} className="flex items-start gap-2">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Button
                    variant={p.highlighted ? 'default' : 'outline'}
                    className="w-full"
                    asChild
                  >
                    <Link href="/register">Start with {p.name}</Link>
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SECTION 10: FAQ */}
        <section className="border-b border-border">
          <div className="mx-auto max-w-[960px] px-4 py-20 sm:px-6 space-y-8">
            <div className="space-y-2">
              <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">FAQ</div>
              <h2 className="font-display text-3xl font-semibold tracking-tight">
                Questions about the engine, compliance, and billing.
              </h2>
            </div>

            <div className="divide-y divide-border border-y border-border">
              {FAQS.map((item, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div key={item.q} className="py-4">
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      className="flex w-full items-center justify-between text-left gap-4"
                    >
                      <span className="text-sm font-medium">{item.q}</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                          isOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {isOpen && (
                      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground pr-8">
                        {item.a}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* SECTION 11: FINAL CTA */}
        <section>
          <div className="mx-auto max-w-[1280px] px-4 py-20 sm:px-6 text-center space-y-6">
            <h2 className="mx-auto max-w-2xl font-display text-3xl sm:text-4xl font-semibold tracking-tight">
              Your creators are already streaming. Start turning streams into distribution.
            </h2>
            <p className="mx-auto max-w-lg text-sm text-muted-foreground">
              Start on the Free tier with 10 clips/month, zero credit card required. Upgrade anytime
              as your clipping network scales.
            </p>
            <Button size="lg" className="h-11 px-7 font-medium" asChild>
              <Link href="/register">
                Create Your Free Workspace <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
