'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { AdminSubnav } from '@/components/admin/AdminSubnav';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest } from '@/lib/saas-types';

interface SecurityPayload {
  auditLogs: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    createdAt: string;
    workspace?: { name: string } | null;
  }>;
  sessions: Array<{
    id: string;
    ipAddress?: string | null;
    expiresAt: string;
    createdAt: string;
    user: { email: string; name: string; systemRole: string };
  }>;
  apiKeys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt?: string | null;
    revokedAt?: string | null;
    workspace?: { name: string };
    user?: { email: string };
  }>;
}

export default function AdminSecurityPage() {
  const { token, notify } = useAuth();
  const [data, setData] = useState<SecurityPayload | null>(null);
  const [auditFilter, setAuditFilter] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<SecurityPayload>('/api/v1/admin/security', { token });
    if (res.ok && res.json.data) setData(res.json.data);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeSession(sessionId: string) {
    if (!token) return;
    const res = await apiRequest(`/api/v1/admin/sessions/${sessionId}/revoke`, {
      method: 'POST',
      token,
    });
    if (res.ok) {
      await load();
      notify('Session terminated immediately.', 'success');
    }
  }

  const filteredLogs = (data?.auditLogs ?? []).filter(
    (l) => !auditFilter.trim() || l.action.toLowerCase().includes(auditFilter.toLowerCase()),
  );

  return (
    <AppShell
      title="Security, Sessions & Audit Log"
      subtitle="Monitor active sessions, workspace API keys, and immutable platform audit trails."
      breadcrumb="ADMIN / SECURITY & AUDIT"
      requireSuperAdmin
    >
      <AdminSubnav />

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 rounded-lg border border-border bg-card overflow-hidden">
            <div className="border-b border-border px-5 py-3.5 text-sm font-display font-semibold">
              Active User Sessions ({data?.sessions.length ?? 0})
            </div>
            <div className="divide-y divide-border">
              {(data?.sessions ?? []).map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs">
                  <div>
                    <div className="font-medium">
                      {s.user.name} <span className="text-muted-foreground">({s.user.email})</span>
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      IP: {s.ipAddress ?? '—'} • Expires {new Date(s.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => revokeSession(s.id)}>
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-5 rounded-lg border border-border bg-card overflow-hidden">
            <div className="border-b border-border px-5 py-3.5 text-sm font-display font-semibold">
              API Keys Inventory ({data?.apiKeys.length ?? 0})
            </div>
            <div className="divide-y divide-border">
              {(data?.apiKeys ?? []).length === 0 ? (
                <div className="p-5 text-xs text-muted-foreground">No API keys created across tenants.</div>
              ) : (
                (data?.apiKeys ?? []).map((k) => (
                  <div key={k.id} className="flex items-center justify-between px-5 py-3 text-xs">
                    <div>
                      <div className="font-medium">{k.name} ({k.workspace?.name})</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{k.keyPrefix}••••</div>
                    </div>
                    <Badge variant={k.revokedAt ? 'outline' : 'default'}>
                      {k.revokedAt ? 'Revoked' : 'Active'}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="border-b border-border px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-sm font-semibold">
              Immutable Audit Log ({filteredLogs.length})
            </h2>
            <Input
              placeholder="Filter by action (e.g. USER_REGISTERED)..."
              aria-label="Filter audit log by action"
              value={auditFilter}
              onChange={(e) => setAuditFilter(e.target.value)}
              className="max-w-xs h-8 text-xs"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border font-mono text-muted-foreground">
                <tr>
                  <th className="p-3">Action</th>
                  <th className="p-3">Entity</th>
                  <th className="p-3">Workspace</th>
                  <th className="p-3">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-mono text-[11px]">
                {filteredLogs.slice(0, 40).map((l) => (
                  <tr key={l.id}>
                    <td className="p-3 font-medium text-foreground">{l.action}</td>
                    <td className="p-3 text-muted-foreground">{l.entityType} ({l.entityId.slice(0, 8)}…)</td>
                    <td className="p-3 font-sans text-muted-foreground">{l.workspace?.name ?? 'Platform'}</td>
                    <td className="p-3 text-muted-foreground">{new Date(l.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
