'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { PlatformIcon, ProfilePhoto } from '@/components/ui/profile-photo';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type ClipJob, type Creator, type RouteRule } from '@/lib/saas-types';
import { humanize } from '@/lib/humanize';

interface CreatorDetail extends Creator {
  routes: RouteRule[];
  clips: ClipJob[];
}

export default function CreatorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { token, notify } = useAuth();
  const [creator, setCreator] = useState<CreatorDetail | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [channelUrl, setChannelUrl] = useState('');
  const [spokenLanguage, setSpokenLanguage] = useState('auto');
  const [checking, setChecking] = useState(false);
  const [topics, setTopics] = useState('');
  const [banned, setBanned] = useState('');
  const [disallowLogos, setDisallowLogos] = useState(true);
  const [autoMonitorEnabled, setAutoMonitorEnabled] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    if (!token || !id) return;
    const res = await apiRequest<CreatorDetail>(`/api/v1/creators/${id}`, { token });
    if (res.ok && res.json.data) {
      setCreator(res.json.data);
      setDisplayName(res.json.data.displayName);
      setChannelUrl(res.json.data.channelUrl);
      setSpokenLanguage(res.json.data.spokenLanguage ?? 'auto');
      setTopics(res.json.data.requiredTopics.join(', '));
      setBanned(res.json.data.bannedKeywords.join(', '));
      setDisallowLogos(res.json.data.disallowLogos);
      setAutoMonitorEnabled(res.json.data.autoMonitorEnabled);
    }
  }, [token, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveChanges(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !id) return;
    const res = await apiRequest(`/api/v1/creators/${id}`, {
      method: 'PATCH',
      token,
      body: {
        displayName,
        channelUrl: channelUrl.trim(),
        spokenLanguage,
        requiredTopics: topics.split(',').map((s) => s.trim()).filter(Boolean),
        bannedKeywords: banned.split(',').map((s) => s.trim()).filter(Boolean),
        disallowLogos,
        autoMonitorEnabled,
      },
    });
    if (res.ok) {
      await load();
      notify('Creator settings updated.', 'success');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not save creator settings.', 'error');
    }
  }

  /** Check the channel now instead of waiting for the next scheduled scan. */
  async function checkChannel() {
    if (!token || !id) return;
    setChecking(true);
    const res = await apiRequest<{ unavailableChannels: string[]; detectedVideos: unknown[] }>('/api/v1/monitor/scan', {
      method: 'POST', token, body: { creatorId: id },
    });
    setChecking(false);
    await load();
    if (!res.ok || !res.json.data) notify('Could not check the channel. Retry.', 'error');
    else if (res.json.data.unavailableChannels.length) notify('The channel could not be read. Check its URL.', 'error');
    else notify(`Channel checked: ${res.json.data.detectedVideos.length} new recording(s).`, 'success');
  }

  async function handleDelete() {
    if (!token || !id) return;
    const res = await apiRequest(`/api/v1/creators/${id}`, { method: 'DELETE', token });
    if (res.ok) {
      notify('Creator deleted.', 'success');
      router.push('/creators');
    } else {
      notify('Only Workspace Admins/Owners can delete creators.', 'error');
    }
  }

  return (
    <AppShell
      title={creator ? `${creator.displayName} (@${creator.handle})` : 'Creator Details'}
      subtitle={creator ? `${creator.platform} • ${creator.channelUrl}` : undefined}
      breadcrumb="DISTRIBUTION / CREATORS / DETAIL"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href={`/clips/new/creator/${id}`}>Browse videos</Link>
          </Button>
          {!confirmDelete ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5 text-destructive" /> Delete
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={handleDelete}>
              Confirm Delete
            </Button>
          )}
        </div>
      }
    >
      {creator && (
        <div className="mb-6 flex items-center gap-4 rounded-lg border border-border bg-card p-4">
          <ProfilePhoto src={creator.avatarUrl} name={creator.displayName} size={56} />
          <div className="min-w-0">
            <div className="font-display text-base font-semibold">{creator.displayName}</div>
            <a href={creator.channelUrl} target="_blank" rel="noreferrer"
              className="mt-0.5 inline-flex max-w-full items-center gap-1.5 truncate text-xs text-muted-foreground hover:text-primary">
              <PlatformIcon platform={creator.platform} /> @{creator.handle}
            </a>
          </div>
        </div>
      )}
      {!creator ? (
        <p className="text-xs text-muted-foreground">Loading creator...</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={saveChanges}
            className="lg:col-span-5 rounded-lg border border-border bg-card p-5 space-y-4"
          >
            <h2 className="font-display text-sm font-semibold">Compliance &amp; Identity Rules</h2>
            {creator.sourceAccessError && (
              <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <span>{creator.sourceAccessError}</span>
                <Button type="button" size="sm" variant="outline" disabled={checking} onClick={() => void checkChannel()}>
                  {checking ? 'Checking...' : 'Retry'}
                </Button>
              </div>
            )}
            <div className="space-y-1">
              <Label>Display Name</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Channel URL</Label>
              <Input type="url" value={channelUrl} onChange={(e) => setChannelUrl(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Spoken Language</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={spokenLanguage}
                onChange={(e) => setSpokenLanguage(e.target.value)}
              >
                <option value="auto">Detect automatically</option>
                <option value="en">English</option>
                <option value="ne">Nepali (नेपाली)</option>
                <option value="hi">Hindi (हिन्दी)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Required Topics</Label>
              <Input value={topics} onChange={(e) => setTopics(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Banned Keywords</Label>
              <Input value={banned} onChange={(e) => setBanned(e.target.value)} />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">Enforce Zero-Logo Policy</span>
              <Switch checked={disallowLogos} onCheckedChange={setDisallowLogos} />
            </div>
            <div className="flex items-center justify-between pt-1">
              <Label htmlFor="auto-monitor">Automatic Monitoring</Label>
              <Switch id="auto-monitor" checked={autoMonitorEnabled} onCheckedChange={setAutoMonitorEnabled} />
            </div>
            <Button type="submit" size="sm">Save Changes</Button>
          </form>

          <div className="lg:col-span-7 space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold">Associated Routes ({creator.routes.length})</h2>
                <Link href="/routes" className="text-xs text-primary hover:underline">Manage routes</Link>
              </div>
              {creator.routes.length === 0 ? (
                <p className="text-xs text-muted-foreground">No routes linked to this creator yet.</p>
              ) : (
                <div className="space-y-2">
                  {creator.routes.map((r) => (
                    <div key={r.id} className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs">
                      <span>{r.socialAccount?.accountHandle} ({r.socialAccount?.platform})</span>
                      <Badge variant="outline">Min Score {r.minComplianceScore}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-card p-5 space-y-3">
              <h2 className="font-display text-sm font-semibold">Recent Clips ({creator.clips.length})</h2>
              {creator.clips.length === 0 ? (
                <p className="text-xs text-muted-foreground">No clips ingested for this creator yet.</p>
              ) : (
                <div className="divide-y divide-border border-t border-border">
                  {creator.clips.map((c) => (
                    <Link
                      key={c.id}
                      href={`/clips/${c.id}`}
                      className="flex items-center justify-between py-2.5 text-xs hover:text-primary"
                    >
                      <span className="font-medium">{c.title}</span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {c.complianceScore}/100 • {humanize(c.approvalStatus)}
                      </Badge>
                    </Link>
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
