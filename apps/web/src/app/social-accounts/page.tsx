'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, GitBranch, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { PlatformIcon, ProfilePhoto } from '@/components/ui/profile-photo';
import { humanize } from '@/lib/humanize';
import { apiRequest, type SocialAccount } from '@/lib/saas-types';

const providers = [
  { id: 'youtube', platform: 'YOUTUBE_SHORTS', label: 'YouTube', note: 'Posts Shorts, unlisted first so you can check them.', tint: 'bg-red-500/15 text-red-500' },
  { id: 'tiktok', platform: 'TIKTOK', label: 'TikTok', note: 'Sends clips to your TikTok inbox to finish posting.', tint: 'bg-foreground/10 text-foreground' },
  { id: 'instagram', platform: 'INSTAGRAM_REELS', label: 'Instagram', note: 'Posts Reels. Needs a business or creator account.', tint: 'bg-pink-500/15 text-pink-500' },
  { id: 'facebook', platform: 'FACEBOOK_REELS', label: 'Facebook Page', note: 'Posts Reels to a Page you manage.', tint: 'bg-blue-500/15 text-blue-500' },
  { id: 'x', platform: 'X', label: 'X', note: 'Posts the clip with its caption.', tint: 'bg-foreground/10 text-foreground' },
] as const;
type DirectProvider = typeof providers[number]['id'];
type AccountChoice = { id: string; name: string; handle: string; avatarUrl?: string | null };

export default function SocialAccountsPage() {
  const { token, notify, user } = useAuth();
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [ready, setReady] = useState<Record<string, boolean> | null>(null);
  const [workspaceAutoPublish, setWorkspaceAutoPublish] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [directBusy, setDirectBusy] = useState(false);
  const [selection, setSelection] = useState<{ state: string; choices: AccountChoice[] } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const [list, status, automation] = await Promise.all([
      apiRequest<SocialAccount[]>('/api/v1/social-accounts', { token }),
      apiRequest<{ id: string; ready: boolean }[]>('/api/v1/social-accounts/providers', { token }),
      apiRequest<{ autoPublishEnabled: boolean }>('/api/v1/workspace/automation', { token }),
    ]);
    setAccounts(list.ok && list.json.data ? list.json.data : []);
    setReady(status.ok && status.json.data ? Object.fromEntries(status.json.data.map((p) => [p.id, p.ready])) : {});
    if (automation.ok && automation.json.data) setWorkspaceAutoPublish(automation.json.data.autoPublishEnabled);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const finishDirect = useCallback(async (state: string, code?: string, accountId?: string) => {
    if (!token) return;
    setDirectBusy(true);
    try {
      const res = await apiRequest<{ accountHandle?: string; accountName?: string; choices?: AccountChoice[] }>('/api/v1/social-accounts/direct/complete', {
        method: 'POST', token, body: { state, code, accountId },
      });
      if (!res.ok) {
        notify(typeof res.json.error === 'string' ? res.json.error : 'Connection could not be confirmed.', 'error');
        return;
      }
      if (res.json.data?.choices) {
        setSelection({ state, choices: res.json.data.choices });
        return;
      }
      setSelection(null);
      // Onboarding asked to route its creator's clips to the account connected here.
      let routeCreatorId: string | null = null;
      try {
        routeCreatorId = window.sessionStorage.getItem('clipnetwork.routeCreatorId');
        window.sessionStorage.removeItem('clipnetwork.routeCreatorId');
      } catch { /* optional */ }
      const connectedId = (res.json.data as { id?: string } | undefined)?.id;
      if (routeCreatorId && connectedId) {
        await apiRequest('/api/v1/routes', {
          method: 'POST', token,
          body: { creatorId: routeCreatorId, socialAccountId: connectedId, minComplianceScore: 70, hashtags: ['clips', 'shorts'] },
        });
      }
      await load();
      notify(`Connected ${res.json.data?.accountName ?? res.json.data?.accountHandle ?? 'account'}.`, 'success');
    } catch {
      notify('Could not confirm the connection. Start authorization again.', 'error');
    } finally {
      setDirectBusy(false);
    }
  }, [load, notify, token]);

  useEffect(() => {
    if (!token) return;
    const url = new URL(window.location.href);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const denied = url.searchParams.has('error');
    if (!state || (!code && !denied)) return;
    for (const key of ['state', 'code', 'error', 'error_description', 'error_reason', 'scope', 'authuser', 'prompt']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url);
    if (denied) { notify('Authorization was declined or cancelled.', 'info'); return; }
    if (code) void finishDirect(state, code);
  }, [finishDirect, notify, token]);

  async function startDirect(provider: DirectProvider) {
    if (!token) return;
    setDirectBusy(true);
    setConnecting(provider);
    try {
      const res = await apiRequest<{ url: string }>(`/api/v1/social-accounts/direct/${provider}/connect`, { method: 'POST', token });
      if (res.ok && res.json.data?.url) {
        // Leaves for the platform's own sign-in page; it returns here with an authorization code.
        window.location.assign(res.json.data.url);
        return;
      }
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not start authorization.', 'error');
    } catch {
      notify('Could not reach the API to start authorization.', 'error');
    }
    setDirectBusy(false);
    setConnecting(null);
  }

  async function toggleAuto(id: string, nextVal: boolean) {
    if (!token) return;
    const res = await apiRequest(`/api/v1/social-accounts/${id}/auto-publish`, {
      method: 'PATCH',
      token,
      body: { autoPublishApproved: nextVal },
    });
    await load();
    if (res.ok) notify(`Automatic posting ${nextVal ? 'on' : 'off'} for this account.`, 'info');
    else notify(typeof res.json.error === 'string' ? res.json.error : 'Could not change automatic posting.', 'error');
  }

  async function disconnect(account: SocialAccount) {
    if (!token || !window.confirm(`Disconnect ${account.accountName}? Routing rules that post to it stop.`)) return;
    const res = await apiRequest(`/api/v1/social-accounts/${account.id}`, { method: 'DELETE', token });
    if (res.ok) {
      await load();
      notify('Social account disconnected.', 'info');
    }
  }

  const isPlatformAdmin = user?.systemRole === 'SUPER_ADMIN';
  const connectedCount = (platform: string) => accounts?.filter((a) => a.platform === platform).length ?? 0;
  const providerFor = (platform: string) => providers.find((p) => p.platform === platform);

  return (
    <AppShell
      title="Social Accounts"
      subtitle="Connect the accounts your clips are posted to. You sign in on each platform; we never see your password."
      breadcrumb="DISTRIBUTION / SOCIAL ACCOUNTS"
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link href="/routes"><GitBranch className="mr-1.5 h-3.5 w-3.5" /> Routing rules</Link>
        </Button>
      }
    >
      <div className="space-y-8">
        {selection && (
          <section role="dialog" aria-label="Choose an account" className="rounded-lg border border-primary/50 bg-card p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold">Which account should clips go to?</h2>
            <p className="text-xs text-muted-foreground">You manage more than one. Pick one now; connect again to add another.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {selection.choices.map((choice) => (
                <Button key={choice.id} variant="outline" disabled={directBusy} className="h-auto justify-start gap-3 py-2.5"
                  onClick={() => void finishDirect(selection.state, undefined, choice.id)}>
                  <ProfilePhoto src={choice.avatarUrl} name={choice.name} size={32} />
                  <span className="min-w-0 text-left">
                    <span className="block truncate">{choice.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{choice.handle}</span>
                  </span>
                </Button>
              ))}
            </div>
            <Button variant="ghost" size="sm" disabled={directBusy} onClick={() => setSelection(null)}>Cancel</Button>
          </section>
        )}

        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-sm font-semibold">Your accounts{accounts?.length ? ` (${accounts.length})` : ''}</h2>
          </div>
          {workspaceAutoPublish === false && accounts?.some((a) => a.autoPublishApproved) && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Automatic posting is off for the whole workspace, so clips still wait for approval.{' '}
                <Link href="/settings/workspace" className="underline">Turn it on in Workspace settings</Link>.</span>
            </p>
          )}
          {accounts === null ? (
            <p role="status" className="text-xs text-muted-foreground">Loading accounts…</p>
          ) : accounts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium">No accounts connected yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Connect one below and approved clips can be posted to it.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {accounts.map((a) => {
                const provider = providerFor(a.platform);
                const signedIn = a.integrationMode === 'LIVE_OAUTH';
                return (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="relative shrink-0">
                        <ProfilePhoto src={a.avatarUrl} name={a.accountName} size={44} />
                        <span className={`absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-card ${provider?.tint ?? 'bg-muted'}`}>
                          <PlatformIcon platform={a.platform} className="h-3 w-3" />
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{a.accountName}</div>
                        <div className="truncate text-xs text-muted-foreground">{provider?.label ?? humanize(a.platform)} · {a.accountHandle}</div>
                        {signedIn
                          ? <Badge variant="secondary" className="mt-1 text-[10px]">Connected</Badge>
                          : <Badge variant="destructive" className="mt-1 text-[10px]">Needs sign-in</Badge>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Post automatically</span>
                        <Switch checked={a.autoPublishApproved} disabled={!signedIn} onCheckedChange={(v) => void toggleAuto(a.id, v)} />
                      </label>
                      {!signedIn && provider && ready?.[provider.id] && (
                        <Button size="sm" variant="outline" disabled={directBusy} onClick={() => void startDirect(provider.id)}>
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reconnect
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Disconnect ${a.accountName}`} onClick={() => void disconnect(a)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-sm font-semibold">Add an account</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {providers.map(({ id, platform, label, note, tint }) => {
              const available = ready === null ? null : Boolean(ready[id]);
              const linked = connectedCount(platform);
              return (
                <li key={id} className={`flex flex-col gap-3 rounded-lg border border-border bg-card p-4 ${available === false ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-3">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tint}`}>
                      <PlatformIcon platform={platform} className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {label}
                        {linked > 0 && <Badge variant="secondary" className="text-[10px]">{linked} connected</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
                    </div>
                  </div>
                  {available === false ? (
                    isPlatformAdmin ? (
                      <Button size="sm" variant="outline" asChild className="mt-auto">
                        <Link href="/admin/integrations">Add {label} keys in Integrations</Link>
                      </Button>
                    ) : (
                      <p className="mt-auto text-xs text-muted-foreground">Coming soon</p>
                    )
                  ) : (
                    <Button size="sm" variant={linked ? 'outline' : 'default'} className="mt-auto" disabled={directBusy || available === null}
                      onClick={() => void startDirect(id)}>
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      {connecting === id ? 'Opening sign-in…' : linked ? `Add another ${label} account` : `Connect ${label}`}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ExternalLink className="h-3 w-3" aria-hidden="true" /> You can revoke access at any time, here or in the platform&apos;s own security settings.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
