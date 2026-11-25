'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { AdminSubnav } from '@/components/admin/AdminSubnav';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest } from '@/lib/saas-types';

interface AdminWorkspace {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  subscriptionStatus: string;
  clipsUsedThisPeriod: number;
  monthlyClipLimit: number;
  ownerEmail: string;
  ownerName: string;
  counts: { members: number; creators: number; socialAccounts: number; clips: number; publishPosts: number };
}

export default function AdminWorkspacesPage() {
  const { token, notify } = useAuth();
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<AdminWorkspace[]>('/api/v1/admin/workspaces', { token });
    if (res.ok && res.json.data) setWorkspaces(res.json.data);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function overridePlan(workspaceId: string, planTier: string) {
    if (!token) return;
    const res = await apiRequest(`/api/v1/admin/workspaces/${workspaceId}/plan`, {
      method: 'PATCH',
      token,
      body: { planTier, subscriptionStatus: 'ACTIVE' },
    });
    if (res.ok) {
      await load();
      notify(`Workspace plan updated to ${planTier}.`, 'success');
    }
  }

  const filtered = workspaces.filter(
    (w) =>
      !q.trim() ||
      w.name.toLowerCase().includes(q.toLowerCase()) ||
      w.ownerEmail.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <AppShell
      title="Tenant Workspaces"
      subtitle="Inspect all customer workspaces, quotas, usage, and override plan entitlements."
      breadcrumb="ADMIN / WORKSPACES"
      requireSuperAdmin
    >
      <AdminSubnav />

      <div className="space-y-4">
        <Input
          placeholder="Search workspaces or owner email..."
          aria-label="Search workspaces"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm h-9 text-xs"
        />
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border font-mono text-muted-foreground">
              <tr>
                <th className="p-3.5">Workspace</th>
                <th className="p-3.5">Owner</th>
                <th className="p-3.5">Entities</th>
                <th className="p-3.5">Quota</th>
                <th className="p-3.5">Status</th>
                <th className="p-3.5 text-right">Admin Plan Override</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border tabular-nums">
              {filtered.map((w) => (
                <tr key={w.id}>
                  <td className="p-3.5">
                    <div className="font-medium">{w.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{w.slug}</div>
                  </td>
                  <td className="p-3.5 text-muted-foreground">{w.ownerEmail}</td>
                  <td className="p-3.5 font-mono text-[11px] text-muted-foreground">
                    {w.counts.creators} cr • {w.counts.clips} clips • {w.counts.publishPosts} posts
                  </td>
                  <td className="p-3.5 font-mono">
                    {w.clipsUsedThisPeriod} / {w.monthlyClipLimit}
                  </td>
                  <td className="p-3.5">
                    <Badge variant={w.subscriptionStatus === 'ACTIVE' ? 'outline' : 'destructive'}>
                      {w.subscriptionStatus}
                    </Badge>
                  </td>
                  <td className="p-3.5 text-right">
                    <select
                      aria-label={`Plan for ${w.name}`}
                      className="h-8 rounded border border-input bg-background px-2 font-mono text-[11px]"
                      value={w.planTier}
                      onChange={(e) => overridePlan(w.id, e.target.value)}
                    >
                      <option value="FREE">FREE</option>
                      <option value="STARTER">STARTER</option>
                      <option value="PRO">PRO</option>
                      <option value="ENTERPRISE">ENTERPRISE</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
