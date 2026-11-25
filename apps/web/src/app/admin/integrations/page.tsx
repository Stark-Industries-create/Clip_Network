'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { AdminSubnav } from '@/components/admin/AdminSubnav';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest } from '@/lib/saas-types';

type Field = { key: string; label: string; secret: boolean; hint: string | null; source: 'ADMIN' | 'ENVIRONMENT' | 'MISSING'; preview: string | null };
type Group = { id: string; title: string; description: string; docsUrl: string | null; ready: boolean; fields: Field[] };
type Integrations = { redirectUri: string; googleLoginRedirectUri: string; webhookUrl: string; encryptionReady: boolean; groups: Group[] };

const SOURCE_LABEL = { ADMIN: 'Saved here', ENVIRONMENT: 'From server environment', MISSING: 'Not set' } as const;

function CopyValue({ label, value }: { label: string; value: string }) {
  const { notify } = useAuth();
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px]">{value}</code>
        <Button type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard.writeText(value).then(() => notify('Copied.', 'success'))}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function GroupCard({ group, data, onSaved }: { group: Group; data: Integrations; onSaved: () => Promise<void> }) {
  const { token, notify } = useAuth();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const dirty = Object.values(values).some((value) => value.trim());

  async function save(changes: Record<string, string | null>) {
    if (!token) return false;
    setBusy(true);
    const res = await apiRequest('/api/v1/admin/integrations', { method: 'PUT', token, body: { values: changes } });
    setBusy(false);
    if (!res.ok) {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Could not save.', 'error');
      return false;
    }
    setValues({});
    await onSaved();
    return true;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const changes = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
    if (await save(changes)) notify(`${group.title} saved.`, 'success');
  }

  async function clear(field: Field) {
    if (!window.confirm(`Remove the saved ${field.label}?`)) return;
    if (await save({ [field.key]: null })) notify(`${field.label} removed.`, 'info');
  }

  async function stripeAction(path: 'verify' | 'webhook') {
    if (!token) return;
    setBusy(true);
    const res = await apiRequest<{ account?: { accountName: string; livemode: boolean }; url?: string }>(
      `/api/v1/admin/integrations/stripe/${path}`, { method: 'POST', token });
    setBusy(false);
    if (!res.ok) {
      notify(typeof res.json.error === 'string' ? res.json.error : 'Stripe request failed.', 'error');
      return;
    }
    if (path === 'verify') {
      const account = res.json.data?.account;
      notify(`Connected to ${account?.accountName ?? 'Stripe'} (${account?.livemode ? 'live' : 'test'} mode). Plan prices are ready.`, 'success');
    } else {
      notify('Webhook created and its signing secret saved.', 'success');
    }
    await onSaved();
  }

  const stripeKeySet = group.id === 'stripe' && group.fields.some((field) => field.key === 'STRIPE_SECRET_KEY' && field.source !== 'MISSING');

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
            {group.ready
              ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
              : <CircleDashed className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            {group.title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={group.ready ? 'default' : 'outline'}>{group.ready ? 'Ready' : 'Not set up'}</Badge>
          {group.docsUrl && (
            <a href={group.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Get keys <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </div>
      </div>

      {group.id === 'stripe'
        ? <div className="mt-4"><CopyValue label="Webhook URL (the Create webhook button registers it for you)" value={data.webhookUrl} /></div>
        : group.id === 'google-login'
          ? <div className="mt-4"><CopyValue label="Sign-in redirect URI to register on the Google client" value={data.googleLoginRedirectUri} /></div>
          : group.id !== 'email' && data.redirectUri && (
            <div className="mt-4"><CopyValue label="Redirect URI to register in the developer console" value={data.redirectUri} /></div>
          )}

      <form onSubmit={onSubmit} className="mt-4 grid gap-3 sm:grid-cols-2">
        {group.fields.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label>{field.label}</Label>
            <Input
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={field.preview ?? field.hint ?? ''}
              value={values[field.key] ?? ''}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            />
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="truncate">{SOURCE_LABEL[field.source]}{field.preview && field.source !== 'MISSING' ? `: ${field.preview}` : ''}</span>
              {field.source === 'ADMIN' && (
                <button type="button" className="shrink-0 text-destructive hover:underline" onClick={() => void clear(field)}>Remove</button>
              )}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Button>
          {group.id === 'stripe' && (
            <>
              <Button type="button" variant="outline" disabled={busy || !stripeKeySet} onClick={() => void stripeAction('verify')}>
                Test key and create plan prices
              </Button>
              <Button type="button" variant="outline" disabled={busy || !stripeKeySet} onClick={() => void stripeAction('webhook')}>
                Create webhook
              </Button>
            </>
          )}
        </div>
      </form>
    </section>
  );
}

export default function AdminIntegrationsPage() {
  const { token } = useAuth();
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiRequest<Integrations>('/api/v1/admin/integrations', { token });
    if (res.ok && res.json.data) setData(res.json.data);
    else setError(typeof res.json.error === 'string' ? res.json.error : 'Could not load integrations.');
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell
      title="Integrations"
      subtitle="Add the keys for payments, social sign-in and email. Secrets are encrypted and never shown again."
      breadcrumb="ADMIN / INTEGRATIONS"
      requireSuperAdmin
    >
      <AdminSubnav />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {data && !data.encryptionReady && (
        <p role="alert" className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          ENCRYPTION_MASTER_KEY is not set on the server, so saved keys use a development key. Set it before going live.
        </p>
      )}
      {data && (
        <div className="space-y-4">
          {data.groups.map((group) => <GroupCard key={group.id} group={group} data={data} onSaved={load} />)}
        </div>
      )}
    </AppShell>
  );
}
