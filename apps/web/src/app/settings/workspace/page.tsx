'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest } from '@/lib/saas-types';

export default function WorkspaceSettingsPage() {
  const { token, workspace, workspaceRole, refreshSession, notify } = useAuth();
  const [wsName, setWsName] = useState(workspace?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [automation, setAutomation] = useState<{
    autoPublishEnabled: boolean; autoPublishGloballyDisabled: boolean;
    analysisHoursUsed: number; monthlyAnalysisHours: number; maxRecordingHours: number; workerConcurrency: number;
  } | null>(null);
  const canManage = workspaceRole === 'OWNER' || workspaceRole === 'ADMIN';

  useEffect(() => {
    if (!token) return;
    void apiRequest<NonNullable<typeof automation>>('/api/v1/workspace/automation', { token })
      .then((res) => { if (res.ok && res.json.data) setAutomation(res.json.data); });
  }, [token]);

  async function setAutoPublish(enabled: boolean) {
    if (!token) return;
    const res = await apiRequest<NonNullable<typeof automation>>('/api/v1/workspace/automation', {
      method: 'PATCH', token, body: { autoPublishEnabled: enabled },
    });
    if (res.ok && res.json.data) {
      setAutomation(res.json.data);
      notify(enabled ? 'Automatic publishing is on for approved destinations.' : 'Automatic publishing is off.', 'success');
    } else {
      notify('Only workspace owners and admins can change automatic publishing.', 'error');
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    const res = await apiRequest('/api/v1/account/profile', {
      method: 'PATCH',
      token,
      body: { workspaceName: wsName },
    });
    setBusy(false);
    if (res.ok) {
      await refreshSession();
      notify('Workspace name updated.', 'success');
    }
  }

  return (
    <AppShell
      title="Workspace Settings"
      subtitle="Manage workspace identity, team access, profile, and notifications."
      breadcrumb="SETTINGS / WORKSPACE"
    >
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2 border-b border-border pb-4 text-xs">
          {[
            ['/settings/workspace', 'Workspace'],
            ['/settings/team', 'Team & RBAC'],
            ['/settings/profile', 'Profile'],
            ['/settings/notifications', 'Notifications'],
            ['/settings/api-keys', 'API Keys'],
            ['/settings/billing', 'Billing'],
            ['/settings/usage', 'Usage'],
          ].map(([href, label]) => (
            <Button key={href} size="sm" variant={href === '/settings/workspace' ? 'default' : 'outline'} asChild>
              <Link href={href}>{label}</Link>
            </Button>
          ))}
        </div>

        <form onSubmit={save} className="max-w-lg rounded-lg border border-border bg-card p-6 space-y-4">
          <div className="space-y-1">
            <Label>Workspace Name</Label>
            <Input value={wsName} onChange={(e) => setWsName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs font-mono text-muted-foreground">
            <div>Slug: <span className="text-foreground">{workspace?.slug}</span></div>
            <div>Your Role: <span className="text-foreground">{workspaceRole}</span></div>
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving...' : 'Save Workspace'}
          </Button>
        </form>

        {automation && (
          <section className="max-w-lg rounded-lg border border-border bg-card p-6 space-y-3">
            <h2 className="text-sm font-semibold">Automation</h2>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={automation.autoPublishEnabled}
                disabled={!canManage || automation.autoPublishGloballyDisabled}
                onChange={(e) => void setAutoPublish(e.target.checked)}
              />
              <span>
                Publish finished clips automatically
                <span className="block text-xs text-muted-foreground">
                  Only to destinations that also allow automatic posting. Everything else waits for review.
                  {automation.autoPublishGloballyDisabled && ' Automatic posting is paused for all workspaces by the operator.'}
                </span>
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Your plan analyzes up to {automation.monthlyAnalysisHours} hours of recordings a month
              ({automation.analysisHoursUsed} used), {automation.maxRecordingHours} hours per recording,
              with {automation.workerConcurrency} {automation.workerConcurrency === 1 ? 'job' : 'jobs'} at a time.
            </p>
          </section>
        )}
      </div>
    </AppShell>
  );
}
