'use client';

import React, { useState } from 'react';
import { CheckCircle2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest } from '@/lib/saas-types';

interface EvalResult {
  passed: boolean;
  score: number;
  matchedTopics: string[];
  disqualifiersTriggered: string[];
  reasons: string[];
}

export default function CampaignsPage() {
  const { token } = useAuth();
  const [caption, setCaption] = useState('Lacy GTA 6 Marathon Hype Moment');
  const [transcript, setTranscript] = useState(
    'We are live on the GTA 6 marathon tonight and chat is going crazy!',
  );
  const [requiredTopics, setRequiredTopics] = useState('GTA, marathon');
  const [bannedKeywords, setBannedKeywords] = useState('gambling, crypto');
  const [disallowLogos, setDisallowLogos] = useState(true);
  const [hasAddedLogos, setHasAddedLogos] = useState(false);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function runEvaluation(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    const res = await apiRequest<EvalResult>('/api/v1/compliance/evaluate', {
      method: 'POST',
      token,
      body: {
        caption,
        transcript,
        requiredTopics: requiredTopics.split(',').map((s) => s.trim()).filter(Boolean),
        bannedKeywords: bannedKeywords.split(',').map((s) => s.trim()).filter(Boolean),
        disallowLogos,
        hasAddedLogos,
      },
    });
    setBusy(false);
    if (res.ok && res.json.data) setResult(res.json.data);
  }

  return (
    <AppShell
      title="Campaign Compliance"
      subtitle="Test and verify rules using the exact server-side evaluateClipCompliance() engine."
      breadcrumb="DISTRIBUTION / CAMPAIGNS"
    >
      <div className="grid gap-6 lg:grid-cols-12">
        <form
          onSubmit={runEvaluation}
          className="lg:col-span-7 rounded-lg border border-border bg-card p-6 space-y-4"
        >
          <div className="space-y-1">
            <h2 className="font-display text-sm font-semibold">Live Compliance Evaluator</h2>
            <p className="text-xs text-muted-foreground">
              Simulate any hook, transcript, and campaign rule set before ingesting clips.
            </p>
          </div>
          <div className="space-y-1">
            <Label>Clip Hook / Caption</Label>
            <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Transcript Excerpt</Label>
            <textarea
              rows={3}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Required Topics</Label>
              <Input value={requiredTopics} onChange={(e) => setRequiredTopics(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Banned Keywords</Label>
              <Input value={bannedKeywords} onChange={(e) => setBannedKeywords(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-6 pt-1 text-xs">
            <label className="flex items-center gap-2">
              <Switch checked={disallowLogos} onCheckedChange={setDisallowLogos} />
              <span>Zero-Logo Policy</span>
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={hasAddedLogos} onCheckedChange={setHasAddedLogos} />
              <span>Clip has an added watermark</span>
            </label>
          </div>
          <Button type="submit" disabled={busy}>
            <ShieldCheck className="mr-1.5 h-4 w-4" />
            {busy ? 'Evaluating...' : 'Run Shared Compliance Gate'}
          </Button>
        </form>

        <div className="lg:col-span-5 rounded-lg border border-border bg-card p-6 space-y-4">
          <h2 className="font-display text-sm font-semibold">Evaluation Report</h2>
          {!result ? (
            <p className="text-xs text-muted-foreground">
              Run an evaluation to see deterministic scoring, matched topics, and disqualifiers.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border border-border bg-background p-4">
                <div className="flex items-center gap-2.5">
                  {result.passed ? (
                    <CheckCircle2 className="h-5 w-5 text-primary" />
                  ) : (
                    <ShieldAlert className="h-5 w-5 text-destructive" />
                  )}
                  <div>
                    <div className="text-sm font-semibold">
                      {result.passed ? 'COMPLIANT — ELIGIBLE' : 'DISQUALIFIED — BLOCKED'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Threshold: 70/100 &amp; 0 disqualifiers
                    </div>
                  </div>
                </div>
                <Badge variant={result.passed ? 'default' : 'destructive'} className="font-mono text-sm">
                  {result.score}/100
                </Badge>
              </div>

              <div className="space-y-2 text-xs">
                <div>
                  <span className="font-mono text-muted-foreground">Matched Topics: </span>
                  <span className="font-medium">
                    {result.matchedTopics.length > 0 ? result.matchedTopics.join(', ') : 'None'}
                  </span>
                </div>
                <div>
                  <span className="font-mono text-muted-foreground">Disqualifiers: </span>
                  <span className="font-medium">
                    {result.disqualifiersTriggered.length > 0
                      ? result.disqualifiersTriggered.join(', ')
                      : 'None'}
                  </span>
                </div>
                {result.reasons.length > 0 && (
                  <ul className="list-disc pl-4 text-destructive space-y-1 pt-1">
                    {result.reasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
