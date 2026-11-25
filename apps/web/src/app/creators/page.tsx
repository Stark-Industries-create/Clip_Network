'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { PlatformIcon, ProfilePhoto } from '@/components/ui/profile-photo';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type Creator } from '@/lib/saas-types';
import { humanize } from '@/lib/humanize';

export default function CreatorsPage() {
  const { token, notify } = useAuth();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState('ALL');
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platform, setPlatform] = useState<'TWITCH' | 'YOUTUBE' | 'KICK'>('TWITCH');
  const [channelUrl, setChannelUrl] = useState('');
  const [requiredTopics, setRequiredTopics] = useState('');
  const [bannedKeywords, setBannedKeywords] = useState('');
  const [spokenLanguage, setSpokenLanguage] = useState('auto');

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<Creator[]>('/api/v1/creators', { token });
    if (res.ok && res.json.data) setCreators(res.json.data);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    const res = await apiRequest('/api/v1/creators', {
      method: 'POST',
      token,
      body: {
        handle: handle.trim(),
        displayName: displayName.trim(),
        platform,
        channelUrl: channelUrl.trim() || {
          TWITCH: `https://www.twitch.tv/${encodeURIComponent(handle.trim().replace(/^@/, ''))}`,
          YOUTUBE: `https://www.youtube.com/@${encodeURIComponent(handle.trim().replace(/^@/, ''))}/streams`,
          KICK: `https://kick.com/${encodeURIComponent(handle.trim().replace(/^@/, ''))}`,
        }[platform],
        tags: [handle.trim()],
        requiredTopics: requiredTopics.split(',').map((s) => s.trim()).filter(Boolean),
        bannedKeywords: bannedKeywords.split(',').map((s) => s.trim()).filter(Boolean),
        disallowLogos: true,
        enableSfx: true,
        spokenLanguage,
      },
    });
    setBusy(false);
    if (res.ok) {
      setHandle('');
      setDisplayName('');
      setChannelUrl('');
      setShowAdd(false);
      await load();
      notify('Creator added to workspace.', 'success');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not add creator.', 'error');
    }
  }

  async function retryChannel(creatorId: string) {
    if (!token) return;
    const res = await apiRequest<{ unavailableChannels: string[]; detectedVideos: unknown[] }>('/api/v1/monitor/scan', {
      method: 'POST', token, body: { creatorId },
    });
    await load();
    if (!res.ok || !res.json.data) notify('Could not check the channel. Retry.', 'error');
    else if (res.json.data.unavailableChannels.length) notify('The channel could not be read. Open it to fix its URL.', 'error');
    else notify(`Channel checked: ${res.json.data.detectedVideos.length} new recording(s).`, 'success');
  }

  const filtered = creators.filter((c) => {
    const matchPlatform = platformFilter === 'ALL' || c.platform === platformFilter;
    const q = search.trim().toLowerCase();
    const matchSearch =
      !q || c.displayName.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q);
    return matchPlatform && matchSearch;
  });

  return (
    <AppShell
      title="Creators"
      subtitle="Manage Twitch, YouTube, and Kick source channels with campaign rules."
      breadcrumb="DISTRIBUTION / CREATORS"
      actions={
        <Button size="sm" onClick={() => setShowAdd((s) => !s)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> {showAdd ? 'Close Form' : 'Add Creator'}
        </Button>
      }
    >
      <div className="space-y-6">
        {showAdd && (
          <form
            onSubmit={onCreate}
            className="rounded-lg border border-border bg-card p-5 grid gap-4 md:grid-cols-2"
          >
            <div className="space-y-1">
              <Label>Handle</Label>
              <Input required placeholder="lacy" value={handle} onChange={(e) => setHandle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Display Name</Label>
              <Input required placeholder="Lacy" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Source Platform</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as 'TWITCH' | 'YOUTUBE' | 'KICK')}
              >
                <option value="TWITCH">TWITCH</option>
                <option value="YOUTUBE">YOUTUBE</option>
                <option value="KICK">KICK</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Channel URL</Label>
              <Input placeholder="https://www.twitch.tv/lacy" value={channelUrl} onChange={(e) => setChannelUrl(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="creator-required-topics">Required Topics (comma-separated)</Label>
              <Input id="creator-required-topics" value={requiredTopics} onChange={(e) => setRequiredTopics(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="creator-banned-keywords">Banned Keywords (comma-separated)</Label>
              <Input id="creator-banned-keywords" value={bannedKeywords} onChange={(e) => setBannedKeywords(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="creator-spoken-language">Spoken language</Label>
              <select
                id="creator-spoken-language"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={spokenLanguage}
                onChange={(e) => setSpokenLanguage(e.target.value)}
              >
                <option value="auto">Detect automatically</option>
                <option value="en">English</option>
                <option value="ne">Nepali (नेपाली)</option>
                <option value="hi">Hindi (हिन्दी)</option>
              </select>
              <p className="text-xs text-muted-foreground">Setting it avoids misdetection on short or mixed-language clips.</p>
            </div>
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Tag Creator'}</Button>
            </div>
          </form>
        )}

        {/* Filter Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search creators..."
              aria-label="Search creators"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9 text-xs"
            />
          </div>
          <div className="flex gap-1.5">
            {['ALL', 'TWITCH', 'YOUTUBE', 'KICK'].map((p) => (
              <Button
                key={p}
                size="sm"
                variant={platformFilter === p ? 'default' : 'outline'}
                onClick={() => setPlatformFilter(p)}
                className="text-xs h-8"
              >
                {p}
              </Button>
            ))}
          </div>
        </div>

        {/* Data Table */}
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          {filtered.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <p className="text-sm font-medium">No creators match your filter</p>
              <p className="text-xs text-muted-foreground">
                Add a Twitch, YouTube, or Kick creator to define campaign rules and ingest clips.
              </p>
              <Button size="sm" onClick={() => setShowAdd(true)}>Add Creator</Button>
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border font-mono text-muted-foreground">
                <tr>
                  <th className="p-3.5">Creator</th>
                  <th className="p-3.5">Platform</th>
                  <th className="p-3.5">Required Topics</th>
                  <th className="p-3.5">Banned Keywords</th>
                  <th className="p-3.5">Defaults</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-secondary/30">
                    <td className="p-3.5">
                      <div className="flex items-center gap-3">
                        <ProfilePhoto src={c.avatarUrl} name={c.displayName} size={36} />
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">{c.displayName}</div>
                          <div className="font-mono text-muted-foreground">@{c.handle}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3.5">
                      <Badge variant="outline" className="gap-1"><PlatformIcon platform={c.platform} />{humanize(c.platform)}</Badge>
                    </td>
                    <td className="p-3.5 text-muted-foreground">{c.requiredTopics.join(', ') || 'Any'}</td>
                    <td className="p-3.5 text-muted-foreground">{c.bannedKeywords.join(', ') || 'None'}</td>
                    <td className="p-3.5 font-mono text-[11px] text-muted-foreground">
                      {humanize(c.defaultCaptionStyle)} • {c.enableSfx ? 'SFX ON' : 'SFX OFF'}
                    </td>
                    <td className="p-3.5">
                      {c.sourceAccessError ? (
                        <div className="flex items-center gap-2">
                          <span className="text-destructive" title={c.sourceAccessError}>Channel check failed</span>
                          <Button size="sm" variant="outline" className="h-7" onClick={() => void retryChannel(c.id)}>Retry</Button>
                        </div>
                      ) : !c.autoMonitorEnabled ? (
                        <span className="text-muted-foreground">Paused</span>
                      ) : (
                        <span className="text-muted-foreground">{c.lastPolledAt ? 'Monitoring' : 'Waiting for first check'}</span>
                      )}
                    </td>
                    <td className="p-3.5 text-right">
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/creators/${c.id}`}>
                          Inspect <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  );
}
