'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest } from '@/lib/saas-types';

interface MemberRow {
  id: string;
  role: string;
  joinedAt: string;
  user: { id: string; name: string; email: string; status: string; emailVerified: boolean };
}

interface InviteRow {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

export default function TeamSettingsPage() {
  const { token, workspaceRole, notify } = useAuth();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MEMBER' | 'VIEWER'>('MEMBER');
  const [acceptToken, setAcceptToken] = useState('');
  const [lastDevToken, setLastDevToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canManage = workspaceRole === 'OWNER' || workspaceRole === 'ADMIN';

  const load = useCallback(async () => {
    if (!token) return;
    const mRes = await apiRequest<MemberRow[]>('/api/v1/workspace/members', { token });
    if (mRes.ok && mRes.json.data) setMembers(mRes.json.data);
    if (canManage) {
      const iRes = await apiRequest<InviteRow[]>('/api/v1/workspace/invites', { token });
      if (iRes.ok && iRes.json.data) setInvites(iRes.json.data);
    }
  }, [token, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !inviteEmail.trim()) return;
    setBusy(true);
    const res = await apiRequest<{ devInviteToken?: string }>('/api/v1/workspace/members/invite', {
      method: 'POST',
      token,
      body: { email: inviteEmail.trim(), role: inviteRole },
    });
    setBusy(false);
    if (res.ok) {
      setInviteEmail('');
      if (res.json.data?.devInviteToken) setLastDevToken(res.json.data.devInviteToken);
      await load();
      notify('Workspace invitation created.', 'success');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Invite failed.', 'error');
    }
  }

  async function acceptInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !acceptToken.trim()) return;
    setBusy(true);
    const res = await apiRequest('/api/v1/workspace/invites/accept', {
      method: 'POST',
      token,
      body: { token: acceptToken.trim() },
    });
    setBusy(false);
    if (res.ok) {
      setAcceptToken('');
      await load();
      notify('Invitation accepted.', 'success');
    } else {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not accept invite.', 'error');
    }
  }

  async function updateRole(memberId: string, role: string) {
    if (!token) return;
    const res = await apiRequest(`/api/v1/workspace/members/${memberId}/role`, {
      method: 'PATCH',
      token,
      body: { role },
    });
    if (res.ok) {
      await load();
      notify('Member role updated.', 'success');
    }
  }

  async function removeMember(memberId: string) {
    if (!token) return;
    const res = await apiRequest(`/api/v1/workspace/members/${memberId}`, {
      method: 'DELETE',
      token,
    });
    if (res.ok) {
      await load();
      notify('Member removed from workspace.', 'info');
    }
  }

  return (
    <AppShell
      title="Team & RBAC"
      subtitle="Invite team members, assign roles, and enforce server-side workspace permissions."
      breadcrumb="SETTINGS / TEAM"
    >
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7 space-y-6">
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="border-b border-border px-5 py-3.5 text-sm font-display font-semibold">
              Workspace Members ({members.length})
            </div>
            <div className="divide-y divide-border">
              {members.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-xs">
                  <div>
                    <div className="font-medium">{m.user.name}</div>
                    <div className="text-muted-foreground">{m.user.email}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {workspaceRole === 'OWNER' && m.role !== 'OWNER' ? (
                      <select
                        className="h-8 rounded border border-input bg-background px-2 font-mono text-[11px]"
                        value={m.role}
                        onChange={(e) => updateRole(m.id, e.target.value)}
                      >
                        <option value="ADMIN">ADMIN</option>
                        <option value="MEMBER">MEMBER</option>
                        <option value="VIEWER">VIEWER</option>
                      </select>
                    ) : (
                      <Badge variant="outline" className="font-mono">{m.role}</Badge>
                    )}
                    {canManage && m.role !== 'OWNER' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => removeMember(m.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {canManage && invites.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="border-b border-border px-5 py-3.5 text-sm font-display font-semibold">
                Pending Invitations ({invites.length})
              </div>
              <div className="divide-y divide-border">
                {invites.map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between px-5 py-3 text-xs">
                    <span>{inv.email}</span>
                    <Badge variant="secondary" className="font-mono">{inv.role}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-5 space-y-6">
          {canManage && (
            <form onSubmit={sendInvite} className="rounded-lg border border-border bg-card p-5 space-y-3.5">
              <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-primary" /> Invite Team Member
              </h2>
              <div className="space-y-1">
                <Label>Teammate Email</Label>
                <Input
                  type="email"
                  required
                  placeholder="editor@agency.com"
                  aria-label="Teammate email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Assigned Role</Label>
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs font-mono"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER')}
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="MEMBER">MEMBER</option>
                  <option value="VIEWER">VIEWER</option>
                </select>
              </div>
              <Button type="submit" size="sm" className="w-full" disabled={busy}>
                {busy ? 'Sending Invite...' : 'Send Workspace Invitation'}
              </Button>
              {lastDevToken && (
                <div className="rounded border border-primary/40 bg-primary/5 p-2.5 text-[11px] font-mono break-all">
                  Dev invite token: {lastDevToken}
                </div>
              )}
            </form>
          )}

          <form onSubmit={acceptInvite} className="rounded-lg border border-border bg-card p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold">Accept an Invitation</h2>
            <Input
              placeholder="Paste invite token"
              value={acceptToken}
              onChange={(e) => setAcceptToken(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" className="w-full" disabled={busy}>
              Accept Invitation
            </Button>
          </form>

          <div className="rounded-lg border border-border bg-card p-5 space-y-2.5 text-xs">
            <h2 className="font-display text-sm font-semibold">Role Permission Matrix</h2>
            <div className="space-y-1.5 text-muted-foreground">
              <div><strong className="text-foreground font-mono">OWNER</strong> — Full billing, roles, API keys, creators &amp; approvals.</div>
              <div><strong className="text-foreground font-mono">ADMIN</strong> — Billing checkout, invites, API keys &amp; creator management.</div>
              <div><strong className="text-foreground font-mono">MEMBER</strong> — Tag creators, connect accounts, ingest clips, approve/publish.</div>
              <div><strong className="text-foreground font-mono">VIEWER</strong> — Read-only access to dashboard, clips, analytics &amp; audit logs.</div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
