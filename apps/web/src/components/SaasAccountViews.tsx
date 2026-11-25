'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  CreditCard,
  KeyRound,
  LifeBuoy,
  ShieldAlert,
  Terminal,
  Trash2,
  UserCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  API_BASE,
  apiRequest,
  type ApiKeyItem,
  type InvoiceItem,
  type PlanDef,
  type SaasUser,
  type SaasWorkspace,
  type SupportTicketItem,
} from '@/lib/saas-types';
import { humanize } from '@/lib/humanize';

interface BillingViewProps {
  token: string;
  workspace: SaasWorkspace;
  plans: PlanDef[];
  onWorkspaceUpdated: () => Promise<void>;
  onNotify: (msg: string) => void;
  onError: (msg: string) => void;
}

export function BillingView({
  token,
  workspace,
  plans,
  onWorkspaceUpdated,
  onNotify,
  onError,
}: BillingViewProps) {
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [busy, setBusy] = useState(false);

  const loadBilling = useCallback(async () => {
    const res = await apiRequest<{ invoices: InvoiceItem[] }>('/api/v1/billing/subscription', {
      token,
    });
    if (res.ok && res.json.data) {
      setInvoices(res.json.data.invoices);
    }
  }, [token]);

  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  // Stripe Checkout returns here with ?checkout=success or ?checkout=cancelled.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('checkout');
    if (!outcome) return;
    url.searchParams.delete('checkout');
    window.history.replaceState(null, '', url);
    if (outcome === 'success') {
      onNotify('Payment received. Your plan updates as soon as Stripe confirms it.');
      // The webhook can land a moment after the redirect; refresh twice to pick it up.
      void onWorkspaceUpdated().then(loadBilling);
      const timer = window.setTimeout(() => void onWorkspaceUpdated().then(loadBilling), 4000);
      return () => window.clearTimeout(timer);
    }
    onError('Checkout was cancelled. You have not been charged.');
  }, [loadBilling, onError, onNotify, onWorkspaceUpdated]);

  async function initiateCheckout(planId: PlanDef['id']) {
    setBusy(true);
    try {
      const res = await apiRequest<{ checkoutUrl?: string; message?: string }>('/api/v1/billing/checkout', {
        method: 'POST',
        token,
        body: { planTier: planId },
      });
      if (res.ok && res.json.data?.checkoutUrl) {
        window.location.href = res.json.data.checkoutUrl;
        return;
      }
      onError(typeof res.json.error === 'string' && res.ok === false
        ? res.json.error
        : 'Payments are not set up yet. The platform admin adds Stripe in Control Center, Integrations.');
    } catch {
      onError('Could not reach billing. Try again.');
    }
    setBusy(false);
  }

  async function openBillingPortal() {
    setBusy(true);
    const res = await apiRequest<{ portalUrl: string }>('/api/v1/billing/portal', {
      method: 'POST',
      token,
    });
    if (res.ok && res.json.data?.portalUrl) {
      window.location.href = res.json.data.portalUrl;
      return;
    }
    setBusy(false);
    onError(typeof res.json.error === 'string' ? res.json.error : 'Could not open the billing portal.');
  }

  async function cancelSubscription() {
    if (!window.confirm('Cancel your subscription? The workspace returns to the Free plan.')) return;
    setBusy(true);
    const res = await apiRequest('/api/v1/billing/cancel', { method: 'POST', token });
    setBusy(false);
    if (res.ok) {
      await onWorkspaceUpdated();
      onNotify('Subscription cancelled. Workspace reverted to Free tier.');
    } else {
      onError(typeof res.json.error === 'string' ? res.json.error : 'Could not cancel the subscription.');
    }
  }

  const pct = Math.min(
    100,
    Math.round((workspace.clipsUsedThisPeriod / Math.max(1, workspace.monthlyClipLimit)) * 100),
  );

  return (
    <div className="space-y-6">
      <Card className="border-border/70 bg-card/85">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="font-display text-lg flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" /> Current Subscription &amp; Usage
            </CardTitle>
            <CardDescription>
              Status: <span className="font-semibold">{humanize(workspace.subscriptionStatus)}</span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{humanize(workspace.planTier)} plan</Badge>
            {workspace.stripeCustomerId && (
              <Button variant="outline" size="sm" onClick={openBillingPortal} disabled={busy}>
                Billing Portal
              </Button>
            )}
            {workspace.planTier !== 'FREE' && (
              <Button variant="outline" size="sm" onClick={cancelSubscription} disabled={busy}>
                Cancel Plan
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Monthly Clip Quota</span>
            <span className="font-mono font-medium">
              {workspace.clipsUsedThisPeriod} / {workspace.monthlyClipLimit} clips ({pct}%)
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => {
          const isCurrent = workspace.planTier === p.id;
          return (
            <Card
              key={p.id}
              className={
                isCurrent
                  ? 'border-primary bg-card ring-1 ring-primary/40'
                  : 'border-border/70 bg-card/70'
              }
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="font-display text-base">{p.name}</CardTitle>
                  {isCurrent && <Badge>Current</Badge>}
                </div>
                <div className="pt-1">
                  <span className="font-display text-2xl font-bold">${p.priceMonthlyUsd}</span>
                  <span className="text-xs text-muted-foreground">/mo</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  className="w-full"
                  size="sm"
                  variant={isCurrent ? 'secondary' : 'default'}
                  disabled={isCurrent || busy}
                  onClick={() => initiateCheckout(p.id)}
                >
                  {isCurrent ? 'Active Plan' : `Switch to ${p.name}`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="border-border/70 bg-card/80">
        <CardHeader>
          <CardTitle className="font-display text-base">Invoice History</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-xs text-muted-foreground">No invoices recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-semibold">{humanize(inv.planTier)}</span>
                    <span className="ml-2 text-muted-foreground">{new Date(inv.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono">${(inv.amountCents / 100).toFixed(2)} {inv.currency}</span>
                    <Badge variant={inv.status === 'PAID' ? 'default' : 'destructive'}>{humanize(inv.status)}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface SettingsAndKeysViewProps {
  token: string;
  user: SaasUser;
  workspace: SaasWorkspace;
  onUpdated: () => Promise<void>;
  onNotify: (msg: string) => void;
}

export function SettingsAndKeysView({
  token,
  user,
  workspace,
  onUpdated,
  onNotify,
}: SettingsAndKeysViewProps) {
  const [name, setName] = useState(user.name);
  const [wsName, setWsName] = useState(workspace.name);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [keyName, setKeyName] = useState('');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    const res = await apiRequest<ApiKeyItem[]>('/api/v1/api-keys', { token });
    if (res.ok && res.json.data) setKeys(res.json.data);
  }, [token]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiRequest('/api/v1/account/profile', {
      method: 'PATCH',
      token,
      body: { name, workspaceName: wsName },
    });
    if (res.ok) {
      await onUpdated();
      onNotify('Profile and workspace updated.');
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiRequest('/api/v1/auth/change-password', {
      method: 'POST',
      token,
      body: { currentPassword: curPw, newPassword: newPw },
    });
    if (res.ok) {
      setCurPw('');
      setNewPw('');
      onNotify('Password updated securely.');
    } else {
      onNotify(typeof res.json.error === 'string' ? res.json.error : 'Password change failed.');
    }
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keyName.trim()) return;
    const res = await apiRequest<{ rawKey: string }>('/api/v1/api-keys', {
      method: 'POST',
      token,
      body: { name: keyName.trim() },
    });
    if (res.ok && res.json.data) {
      setNewlyCreatedKey(res.json.data.rawKey);
      setKeyName('');
      await loadKeys();
      onNotify('API key generated. Copy it now — it will not be shown again.');
    } else {
      onNotify(typeof res.json.error === 'string' ? res.json.error : 'Could not create API key.');
    }
  }

  async function revokeKey(id: string) {
    const res = await apiRequest(`/api/v1/api-keys/${id}/revoke`, { method: 'POST', token });
    if (res.ok) {
      await loadKeys();
      onNotify('API key revoked.');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="border-border/70 bg-card/80">
        <CardHeader>
          <CardTitle className="font-display text-base flex items-center gap-2">
            <UserCog className="h-4 w-4 text-primary" /> Profile &amp; Workspace
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-3">
            <div className="space-y-1">
              <Label>Full Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Workspace Name</Label>
              <Input value={wsName} onChange={(e) => setWsName(e.target.value)} />
            </div>
            <Button type="submit" size="sm">Save Changes</Button>
          </form>

          <hr className="my-5 border-border/60" />

          <form onSubmit={changePassword} className="space-y-3">
            <div className="text-sm font-medium">Change Password</div>
            <Input
              type="password"
              placeholder="Current password"
              value={curPw}
              onChange={(e) => setCurPw(e.target.value)}
            />
            <Input
              type="password"
              placeholder="New password (8+ chars, letter + number)"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">Update Password</Button>
          </form>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-card/80">
        <CardHeader>
          <CardTitle className="font-display text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" /> Workspace API Keys
          </CardTitle>
          <CardDescription>
            Authenticate automated clip ingest jobs via <code className="font-mono">X-Api-Key</code> header.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={createKey} className="flex gap-2">
            <Input
              placeholder="e.g. Twitch Webhook Bot"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
            <Button type="submit" size="sm">Generate</Button>
          </form>

          {newlyCreatedKey && (
            <div className="rounded-lg border border-primary/50 bg-primary/10 p-3 space-y-2">
              <div className="text-xs font-semibold">Copy your new API key (shown once):</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-background/80 px-2 py-1 font-mono text-xs">
                  {newlyCreatedKey}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(newlyCreatedKey);
                    onNotify('Copied API key to clipboard.');
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-xs"
              >
                <div>
                  <div className="font-medium">{k.name}</div>
                  <div className="font-mono text-muted-foreground">{k.keyPrefix}••••••••</div>
                </div>
                {k.revokedAt ? (
                  <Badge variant="outline">Revoked</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => revokeKey(k.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function SupportAndDocsView({
  token,
  onNotify,
}: {
  token: string;
  onNotify: (msg: string) => void;
}) {
  const [tickets, setTickets] = useState<SupportTicketItem[]>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState<'LOW' | 'NORMAL' | 'HIGH'>('NORMAL');

  const loadTickets = useCallback(async () => {
    const res = await apiRequest<SupportTicketItem[]>('/api/v1/support/tickets', { token });
    if (res.ok && res.json.data) setTickets(res.json.data);
  }, [token]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  async function submitTicket(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiRequest('/api/v1/support/tickets', {
      method: 'POST',
      token,
      body: { subject, message, priority },
    });
    if (res.ok) {
      setSubject('');
      setMessage('');
      await loadTickets();
      onNotify('Support ticket submitted.');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="border-border/70 bg-card/80">
        <CardHeader>
          <CardTitle className="font-display text-base flex items-center gap-2">
            <LifeBuoy className="h-4 w-4 text-primary" /> Contact Support
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={submitTicket} className="space-y-3">
            <Input
              required
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
            <textarea
              required
              minLength={10}
              rows={3}
              placeholder="Describe your question or issue..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <div className="flex items-center justify-between">
              <div className="flex gap-1.5">
                {(['LOW', 'NORMAL', 'HIGH'] as const).map((p) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={priority === p ? 'default' : 'outline'}
                    onClick={() => setPriority(p)}
                  >
                    {p}
                  </Button>
                ))}
              </div>
              <Button type="submit" size="sm">Submit Ticket</Button>
            </div>
          </form>

          <div className="space-y-2 pt-2">
            {tickets.map((t) => (
              <div key={t.id} className="rounded-lg border border-border/60 p-3 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{t.subject}</span>
                  <Badge variant="outline">{t.status}</Badge>
                </div>
                <p className="text-muted-foreground">{t.message}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-card/80">
        <CardHeader>
          <CardTitle className="font-display text-base flex items-center gap-2">
            <Terminal className="h-4 w-4 text-primary" /> Engine API Quickstart
          </CardTitle>
          <CardDescription>Trigger automated stream clipping from any webhook or worker.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          <pre className="overflow-x-auto rounded-lg border border-border/60 bg-background/80 p-3 font-mono text-[11px] leading-relaxed">
{`curl -X POST ${API_BASE}/api/v1/clips/ingest \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: cn_live_YOUR_KEY" \\
  -d '{
    "creatorId": "CREATOR_UUID",
    "sourceUrl": "https://www.twitch.tv/videos/2933767012",
    "title": "Viral GTA 6 Marathon Moment",
    "startSec": 120,
    "endSec": 145
  }'`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

export function SuperAdminView({
  token,
  onNotify,
}: {
  token: string;
  onNotify: (msg: string) => void;
}) {
  const [data, setData] = useState<{
    totals: { users: number; workspaces: number; clipsExecuted: number; totalRevenueUsd: number; openTickets: number };
    users: Array<{ id: string; email: string; name: string; systemRole: string; status: string }>;
    workspaces: Array<{ id: string; name: string; planTier: string; clipsUsedThisPeriod: number; monthlyClipLimit: number }>;
  } | null>(null);

  const loadOverview = useCallback(async () => {
    const res = await apiRequest<typeof data>('/api/v1/admin/overview', { token });
    if (res.ok && res.json.data) setData(res.json.data);
  }, [token]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  async function toggleUserStatus(userId: string, currentStatus: string) {
    const nextStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    const res = await apiRequest(`/api/v1/admin/users/${userId}/status`, {
      method: 'PATCH',
      token,
      body: { status: nextStatus },
    });
    if (res.ok) {
      await loadOverview();
      onNotify(`User status updated to ${nextStatus}.`);
    }
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">Loading platform admin telemetry...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: 'Total Users', value: data.totals.users },
          { label: 'Workspaces', value: data.totals.workspaces },
          { label: 'Clips Executed', value: data.totals.clipsExecuted },
          { label: 'Revenue (USD)', value: `$${data.totals.totalRevenueUsd}` },
          { label: 'Open Tickets', value: data.totals.openTickets },
        ].map((kpi) => (
          <Card key={kpi.label} className="border-border/70 bg-card/80">
            <CardContent className="pt-5">
              <div className="text-xs text-muted-foreground">{kpi.label}</div>
              <div className="font-display text-2xl font-bold mt-1">{kpi.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border/70 bg-card/80">
        <CardHeader>
          <CardTitle className="font-display text-base flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" /> Platform Users &amp; Account Governance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.users.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs"
            >
              <div>
                <span className="font-semibold">{u.name}</span>
                <span className="ml-2 text-muted-foreground">{u.email}</span>
                <Badge variant="outline" className="ml-2">{u.systemRole}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={u.status === 'ACTIVE' ? 'default' : 'destructive'}>{u.status}</Badge>
                {u.systemRole !== 'SUPER_ADMIN' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggleUserStatus(u.id, u.status)}
                  >
                    {u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
