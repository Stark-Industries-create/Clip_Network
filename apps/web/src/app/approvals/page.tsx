'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Eye, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type ClipJob } from '@/lib/saas-types';
import { ProfilePhoto, Thumbnail } from '@/components/ui/profile-photo';

export default function ApprovalsQueuePage() {
  const { token, notify } = useAuth();
  const [clips, setClips] = useState<ClipJob[]>([]);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<ClipJob[]>('/api/v1/clips', { token });
    if (res.ok && res.json.data) {
      // Flagged clips (a quality issue such as a cut-off sentence) also wait for a person.
      setClips(res.json.data.filter((c) => c.executionStatus === 'COMPLETED' && ['AWAITING_APPROVAL', 'NEEDS_REVIEW'].includes(c.approvalStatus)));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: 'APPROVED' | 'REJECTED') {
    if (!token) return;
    const res = await apiRequest(`/api/v1/clips/${id}/decision`, {
      method: 'POST',
      token,
      body: { decision },
    });
    if (res.ok) {
      await load();
      notify(`Clip ${decision.toLowerCase()}.`, 'success');
    }
  }

  return (
    <AppShell
      title="Approval Queue"
      subtitle="Human approval is enforced by default before clips release to linked accounts."
      breadcrumb="OPERATIONS / APPROVAL QUEUE"
    >
      {clips.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center space-y-2">
          <p className="text-sm font-medium">All caught up</p>
          <p className="text-xs text-muted-foreground">No clips are currently awaiting human approval.</p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {clips.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
              <Link href={`/clips/${c.id}`} className="flex min-w-0 flex-1 items-center gap-4">
                <div className="relative shrink-0">
                  <Thumbnail src={c.sourceVideo?.thumbnailUrl} className="h-[72px] w-32" />
                  <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 font-mono text-[10px] text-white">{Math.round(c.durationSec)}s</span>
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="line-clamp-2 text-sm font-medium hover:text-primary">{c.title}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ProfilePhoto src={c.creator?.avatarUrl} name={c.creator?.displayName ?? 'Creator'} size={18} />
                    <span>{c.creator?.displayName ?? 'Creator'}</span>
                    <span>·</span>
                    <span>Score {c.complianceScore}/100</span>
                  </div>
                  {c.qualityIssue && <div className="text-xs text-warning">Check before approving: {c.qualityIssue}</div>}
                </div>
              </Link>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{c.approvalStatus === 'NEEDS_REVIEW' ? 'Flagged' : c.compliancePassed ? 'Compliant' : 'Blocked'}</Badge>
                <Button size="sm" variant="ghost" asChild>
                  <Link href={`/clips/${c.id}`}><Eye className="mr-1 h-3.5 w-3.5" /> Inspect</Link>
                </Button>
                <Button size="sm" disabled={!c.compliancePassed} onClick={() => decide(c.id, 'APPROVED')}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => decide(c.id, 'REJECTED')}>
                  <XCircle className="mr-1 h-3.5 w-3.5" /> Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
