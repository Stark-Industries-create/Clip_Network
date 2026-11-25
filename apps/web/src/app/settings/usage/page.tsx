'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest } from '@/lib/saas-types';

export default function SettingsUsagePage() {
  const { token, workspace, plans } = useAuth();
  const [counts, setCounts] = useState({ creators: 0, accounts: 0, keys: 0, analysisHours: 0, analysisLimit: 0 });

  useEffect(() => {
    if (!token) return;
    void Promise.all([
      apiRequest<unknown[]>('/api/v1/creators', { token }),
      apiRequest<unknown[]>('/api/v1/social-accounts', { token }),
      apiRequest<Array<{ revokedAt?: string | null }>>('/api/v1/api-keys', { token }),
      apiRequest<{ analysisHoursUsed: number; monthlyAnalysisHours: number }>('/api/v1/workspace/automation', { token }),
    ]).then(([c, a, k, auto]) => {
      setCounts({
        creators: c.json.data?.length ?? 0,
        accounts: a.json.data?.length ?? 0,
        keys: (k.json.data ?? []).filter((x) => !x.revokedAt).length,
        analysisHours: auto.json.data?.analysisHoursUsed ?? 0,
        analysisLimit: auto.json.data?.monthlyAnalysisHours ?? 0,
      });
    });
  }, [token]);

  const currentPlan = plans.find((p) => p.id === workspace?.planTier);
  const meters = [
    {
      label: 'Monthly Clips',
      used: workspace?.clipsUsedThisPeriod ?? 0,
      limit: workspace?.monthlyClipLimit ?? 10,
    },
    {
      label: 'Recording Analysis (hours)',
      used: counts.analysisHours,
      limit: counts.analysisLimit || 1,
    },
    {
      label: 'Tagged Creators',
      used: counts.creators,
      limit: currentPlan?.maxCreators ?? 2,
    },
    {
      label: 'Linked Social Accounts',
      used: counts.accounts,
      limit: currentPlan?.maxSocialAccounts ?? 2,
    },
    {
      label: 'Active API Keys',
      used: counts.keys,
      limit: currentPlan?.apiKeysAllowed ?? 1,
    },
  ];

  return (
    <AppShell
      title="Usage & Quotas"
      subtitle="Server-enforced entitlements for your current billing period."
      breadcrumb="SETTINGS / USAGE"
      actions={
        <Button size="sm" asChild>
          <Link href="/settings/billing">Upgrade Plan</Link>
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {meters.map((m) => {
          const pct = Math.min(100, Math.round((m.used / Math.max(1, m.limit)) * 100));
          return (
            <div key={m.label} className="rounded-lg border border-border bg-card p-5 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{m.label}</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {m.used} / {m.limit.toLocaleString()} ({pct}%)
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
