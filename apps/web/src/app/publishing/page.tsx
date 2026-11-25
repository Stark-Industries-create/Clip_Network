'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type PublishPost } from '@/lib/saas-types';
import { humanize } from '@/lib/humanize';

interface ExtendedPublishPost extends PublishPost {
  idempotencyKey?: string;
}

export default function PublishingQueuePage() {
  const { token, notify } = useAuth();
  const [posts, setPosts] = useState<ExtendedPublishPost[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<ExtendedPublishPost[]>('/api/v1/publish-queue', { token });
    if (res.ok && res.json.data) setPosts(res.json.data);
    setLoadState(res.ok && res.json.data ? 'ready' : 'error');
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publishNow(id: string, sendTikTokDraft = false) {
    if (!token) return;
    const res = await apiRequest<PublishPost>(`/api/v1/publish-queue/${id}/publish`, { method: 'POST', token, body: { sendTikTokDraft } });
    if (res.ok) {
      await load();
      notify(res.json.data?.status === 'SUBMITTED' ? (sendTikTokDraft ? 'Draft submitted. Finish the post in your TikTok inbox.' : 'Submitted. Waiting for destination confirmation.') : 'Publish action completed.', 'success');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Publish attempt failed. Retry from the queue.', 'error');
    }
  }

  return (
    <AppShell
      title="Publishing Queue"
      subtitle="Every post to your connected accounts, with its status and safe retries."
      breadcrumb="OPERATIONS / PUBLISHING"
    >
      {loadState === 'error' && (
        <div role="alert" className="mb-4 flex items-center gap-3 text-sm">
          <span>Could not load the publishing queue.</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      {posts.length === 0 ? loadState === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">Loading publishing queue…</p>
      ) : loadState === 'ready' && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-xs text-muted-foreground">
          No posts queued yet. Route a creator to a social account and ingest a compliant clip.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border font-mono text-muted-foreground">
              <tr>
                <th className="p-3.5">Clip</th>
                <th className="p-3.5">Destination</th>
                <th className="p-3.5">Mode</th>
                <th className="p-3.5">Status</th>
                <th className="p-3.5">Idempotency / External ID</th>
                <th className="p-3.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {posts.map((p) => (
                <tr key={p.id}>
                  <td className="p-3.5">
                    <div className="font-medium">{p.clipJob?.title ?? 'Clip'}</div>
                    {p.errorMessage && (
                      <div className="text-[11px] text-destructive mt-0.5">{p.errorMessage}</div>
                    )}
                  </td>
                  <td className="p-3.5">
                    <div>{p.socialAccount?.accountHandle}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{p.platform}</div>
                  </td>
                  <td className="p-3.5 text-[11px]">{humanize(p.executionMode)}</td>
                  <td className="p-3.5">
                    <Badge
                      variant={
                        p.status.startsWith('PUBLISHED')
                          ? 'default'
                          : p.status === 'FAILED' || p.status === 'BLOCKED'
                            ? 'destructive'
                            : 'outline'
                      }
                    >
                      {humanize(p.status)}
                    </Badge>
                  </td>
                  <td className="p-3.5 font-mono text-[10px] text-muted-foreground">
                    <div>{p.externalPostId ?? '—'}</div>
                    {p.idempotencyKey && <div className="opacity-70">{p.idempotencyKey.slice(0, 22)}…</div>}
                  </td>
                  <td className="p-3.5 text-right">
                    {p.status === 'AWAITING_APPROVAL' && (
                      <Button size="sm" onClick={() => publishNow(p.id, p.platform === 'TIKTOK' && p.executionMode === 'LIVE_OAUTH')}>
                        <Send className="mr-1.5 h-3 w-3" /> {p.platform === 'TIKTOK' && p.executionMode === 'LIVE_OAUTH' ? 'Send to TikTok inbox' : 'Publish'}
                      </Button>
                    )}
                    {p.status === 'FAILED' && (
                      <Button size="sm" variant="outline" onClick={() => publishNow(p.id, p.platform === 'TIKTOK' && p.executionMode === 'LIVE_OAUTH')}>
                        <RotateCcw className="mr-1.5 h-3 w-3" /> Safe Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
