'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { PlatformIcon, ProfilePhoto } from '@/components/ui/profile-photo';
import { humanize } from '@/lib/humanize';
import { apiRequest, type Creator } from '@/lib/saas-types';

type CreatorRow = Creator & { _count?: { clips: number; channelVideos: number } };

/** Ingest starts from a tagged creator: pick one to browse the recordings detected on their channel. */
export default function IngestCreatorsPage() {
  const { token } = useAuth();
  const [creators, setCreators] = useState<CreatorRow[] | null>(null);

  useEffect(() => {
    if (!token) return;
    void apiRequest<CreatorRow[]>('/api/v1/creators', { token }).then((res) => setCreators(res.ok && res.json.data ? res.json.data : []));
  }, [token]);

  return (
    <AppShell
      title="Ingest"
      subtitle="Pick a tagged creator to see every recording found on their channel."
      breadcrumb="OPERATIONS / INGEST"
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link href="/clips/new/manual"><Scissors className="mr-1.5 h-3.5 w-3.5" /> Cut a clip by hand</Link>
        </Button>
      }
    >
      {creators === null ? (
        <p role="status" className="text-xs text-muted-foreground">Loading creators…</p>
      ) : creators.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center space-y-3">
          <p className="text-sm font-medium">No creators tagged yet</p>
          <p className="text-xs text-muted-foreground">Tag a YouTube, Twitch or Kick channel and its recordings appear here.</p>
          <Button size="sm" asChild><Link href="/creators"><Plus className="mr-1.5 h-3.5 w-3.5" /> Tag a creator</Link></Button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {creators.map((c) => (
            <li key={c.id}>
              <Link href={`/clips/new/creator/${c.id}`}
                className="flex h-full items-center gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/60">
                <ProfilePhoto src={c.avatarUrl} name={c.displayName} size={56} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-sm font-semibold">{c.displayName}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <PlatformIcon platform={c.platform} /> {humanize(c.platform)} · @{c.handle}
                  </div>
                  <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground">
                    <span><strong className="text-foreground">{c._count?.channelVideos ?? 0}</strong> videos found</span>
                    <span><strong className="text-foreground">{c._count?.clips ?? 0}</strong> clips</span>
                  </div>
                  {c.sourceAccessError && <div className="mt-1 truncate text-[11px] text-destructive">{c.sourceAccessError}</div>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
