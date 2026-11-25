'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Clapperboard, Radio, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/components/providers/AuthProvider';
import { PlatformIcon } from '@/components/ui/profile-photo';
import { apiRequest, describeChannelScan, type ChannelScanResult } from '@/lib/saas-types';

const DESTINATIONS = [
  { id: 'youtube', platform: 'YOUTUBE_SHORTS', label: 'YouTube' },
  { id: 'tiktok', platform: 'TIKTOK', label: 'TikTok' },
  { id: 'instagram', platform: 'INSTAGRAM_REELS', label: 'Instagram' },
  { id: 'facebook', platform: 'FACEBOOK_REELS', label: 'Facebook' },
  { id: 'x', platform: 'X', label: 'X' },
] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const { booting, token, user, workspace, devVerificationToken, refreshSession, notify } = useAuth();
  const [step, setStep] = useState(1);
  const [wsName, setWsName] = useState('');
  const [primaryPlatform, setPrimaryPlatform] = useState<'TWITCH' | 'YOUTUBE' | 'KICK'>('TWITCH');

  // Step 3: Creator channel
  const [creatorHandle, setCreatorHandle] = useState('');
  const [creatorName, setCreatorName] = useState('');
  const [creatorTopics, setCreatorTopics] = useState('');
  const [creatorLanguage, setCreatorLanguage] = useState('auto');
  const [createdCreatorId, setCreatedCreatorId] = useState<string | null>(null);

  // Step 4: Posting account
  // The destination to sign in to after setup; null connects one later in Social Accounts.
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  // Off by default: clips wait in the approval queue until the workspace chooses automatic posting.
  const [autoPublish, setAutoPublish] = useState(false);

  const [runInitialScan, setRunInitialScan] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!booting && !user) router.replace('/login');
    if (workspace && !wsName) setWsName(workspace.name);
  }, [booting, user, workspace, wsName, router]);

  if (booting || !user || !workspace || !token) return null;

  async function handleAddFirstCreator() {
    // Going Back and Continue again must not create the creator a second time.
    if (createdCreatorId) {
      setStep(4);
      return;
    }
    const handle = creatorHandle.trim().replace(/^@/, '');
    if (!handle || !creatorName.trim()) {
      notify('Enter a channel handle and display name, or choose Skip.', 'error');
      return;
    }
    setBusy(true);
    const res = await apiRequest<{ id: string }>('/api/v1/creators', {
      method: 'POST',
      token,
      body: {
        handle,
        displayName: creatorName.trim(),
        platform: primaryPlatform,
        channelUrl:
          primaryPlatform === 'YOUTUBE'
            ? `https://www.youtube.com/@${encodeURIComponent(handle)}`
            : primaryPlatform === 'KICK'
              ? `https://kick.com/${creatorHandle.trim()}`
              : `https://www.twitch.tv/${creatorHandle.trim()}`,
        tags: [handle],
        requiredTopics: creatorTopics.split(',').map((s) => s.trim()).filter(Boolean),
        bannedKeywords: [],
        disallowLogos: true,
        enableSfx: true,
        spokenLanguage: creatorLanguage,
      },
    });
    setBusy(false);
    if (res.status === 409 && res.json.data) {
      setCreatedCreatorId(res.json.data.id);
      notify(`${creatorName} is already tagged in this workspace.`, 'info');
      setStep(4);
    } else if (res.ok && res.json.data) {
      setCreatedCreatorId(res.json.data.id);
      notify(`Creator ${creatorName} added with auto-upload monitoring enabled.`, 'success');
      setStep(4);
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not add the creator. Retry.', 'error');
    }
  }

  async function handleChooseDestination() {
    // Automatic posting needs the workspace opt-in too; the switch here means both.
    if (autoPublish) {
      await apiRequest('/api/v1/workspace/automation', { method: 'PATCH', token, body: { autoPublishEnabled: true } });
    }
    setStep(5);
  }

  /** Sends the user to the platform's own sign-in page; it returns to Social Accounts to finish. */
  async function startConnect(provider: string) {
    const res = await apiRequest<{ url: string }>(`/api/v1/social-accounts/direct/${provider}/connect`, { method: 'POST', token });
    if (!res.ok || !res.json.data?.url) {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not start sign-in. Connect it later in Social Accounts.', 'error');
      return false;
    }
    if (createdCreatorId) {
      // Social Accounts routes this creator's clips to the new account once it connects.
      try { window.sessionStorage.setItem('clipnetwork.routeCreatorId', createdCreatorId); } catch { /* optional */ }
    }
    window.location.assign(res.json.data.url);
    return true;
  }

  async function handleComplete() {
    setBusy(true);
    if (!user?.emailVerified && devVerificationToken) {
      await apiRequest('/api/v1/auth/verify-email', {
        method: 'POST',
        body: { token: devVerificationToken },
      });
    }
    const res = await apiRequest('/api/v1/onboarding/complete', {
      method: 'POST',
      token,
      body: {
        workspaceName: wsName.trim() || workspace?.name || 'My Studio',
        primaryPlatform,
        selectedPlan: 'FREE',
      },
    });

    if (res.ok) {
      await refreshSession();
      notify('Workspace ready.', 'success');
      if (runInitialScan && createdCreatorId) {
        const scan = await apiRequest<ChannelScanResult>('/api/v1/monitor/scan', {
          method: 'POST',
          token,
          body: { creatorId: createdCreatorId },
        });
        if (!scan.ok || !scan.json.data) {
          notify('Channel scan failed. Retry from the dashboard.', 'error');
        } else {
          notify(describeChannelScan(scan.json.data), scan.json.data.creatorsScanned ? 'success' : 'error');
        }
      }
      if (connectProvider && await startConnect(connectProvider)) return;
      router.push('/dashboard');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not complete onboarding.', 'error');
    }
    setBusy(false);
  }

  const visibleStep = step === 1 ? 1 : step - 1;

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-6 sm:p-8 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Clapperboard className="h-3.5 w-3.5" />
            </div>
            <span className="font-display text-sm font-semibold">Clip Network Onboarding</span>
          </div>
          <span className="font-mono text-xs text-muted-foreground">Step {visibleStep} / 4</span>
        </div>

        <div className="grid grid-cols-4 gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={visibleStep}
          aria-label="Onboarding progress">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className={`h-1 rounded-full ${s <= visibleStep ? 'bg-primary' : 'bg-secondary'}`} />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h1 className="font-display text-xl font-semibold">Welcome, {user.name}</h1>
              <p className="text-xs text-muted-foreground mt-1">
                Name your workspace and choose the primary creator platform you monitor.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Workspace Name</Label>
              <Input value={wsName} onChange={(e) => setWsName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Primary Source Platform</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['TWITCH', 'YOUTUBE', 'KICK'] as const).map((p) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={primaryPlatform === p ? 'default' : 'outline'}
                    onClick={() => setPrimaryPlatform(p)}
                  >
                    {p}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={() => setStep(3)}>
                Continue <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="font-display text-xl font-semibold">Add a creator channel to monitor</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Clip Network watches this channel for latest &amp; newly uploaded videos and starts clipping automatically.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Creator Handle</Label>
                <Input placeholder="lacy" value={creatorHandle} onChange={(e) => setCreatorHandle(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Display Name</Label>
                <Input placeholder="Lacy" value={creatorName} onChange={(e) => setCreatorName(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Required Campaign Topics (comma-separated)</Label>
                <Input value={creatorTopics} onChange={(e) => setCreatorTopics(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Spoken Language</Label>
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs"
                  value={creatorLanguage}
                  onChange={(e) => setCreatorLanguage(e.target.value)}
                >
                  <option value="auto">Detect automatically</option>
                  <option value="en">English</option>
                  <option value="ne">Nepali (नेपाली)</option>
                  <option value="hi">Hindi (हिन्दी)</option>
                </select>
              </div>
            </div>
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(4)}>Skip</Button>
                <Button onClick={handleAddFirstCreator} disabled={busy}>
                  {busy ? 'Adding...' : createdCreatorId ? 'Continue' : 'Add Channel & Continue'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div>
              <h2 className="font-display text-xl font-semibold">Where should clips be posted?</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Pick a platform. After setup you sign in on that platform to connect the account, and clips from{' '}
                {creatorName || 'your creator'} are routed to it. You can add more in Social Accounts at any time.
              </p>
            </div>
            <div role="radiogroup" aria-label="Destination platform" className="grid gap-2 sm:grid-cols-3">
              {DESTINATIONS.map(({ id, platform, label }) => (
                <button key={id} type="button" role="radio" aria-checked={connectProvider === id}
                  onClick={() => setConnectProvider(connectProvider === id ? null : id)}
                  className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-xs font-medium transition-colors ${
                    connectProvider === id ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background hover:border-primary/50'}`}>
                  <PlatformIcon platform={platform} className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between rounded-md border border-border bg-background p-3 text-xs">
              <div>
                <div className="font-medium">Publish compliant clips automatically</div>
                <div className="text-[11px] text-muted-foreground">
                  Off: every clip waits in the Approval Queue. You can change this later in Settings.
                </div>
              </div>
              <Switch checked={autoPublish} onCheckedChange={setAutoPublish} />
            </label>
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(3)}>Back</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setConnectProvider(null); setStep(5); }}>Skip</Button>
                <Button onClick={() => void handleChooseDestination()} disabled={busy}>Continue</Button>
              </div>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-border bg-background p-4">
              <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs">
                <div className="font-semibold text-foreground">Automated pipeline ready</div>
                <p className="text-muted-foreground">
                  {connectProvider
                    ? `Workspace "${wsName}" is ready. Next you sign in to ${DESTINATIONS.find((d) => d.id === connectProvider)?.label} to connect the account clips are posted to.`
                    : `Workspace "${wsName}" is ready on the Free plan. Connect a posting account any time in Social Accounts.`}
                </p>
              </div>
            </div>

            {createdCreatorId && primaryPlatform === 'YOUTUBE' && (
              <label className="flex items-center justify-between rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <Radio className="h-4 w-4 text-primary" />
                  <span>Scan this channel for new uploads</span>
                </div>
                <Switch checked={runInitialScan} onCheckedChange={setRunInitialScan} />
              </label>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(4)}>Back</Button>
              <Button onClick={handleComplete} disabled={busy}>
                <Rocket className="mr-1.5 h-4 w-4" />
                {busy ? 'Setting up…' : connectProvider ? 'Finish and connect account' : 'Launch Dashboard'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
