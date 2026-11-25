'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PublicFooter, PublicNavbar } from '@/components/layout/PublicChrome';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type PlanDef } from '@/lib/saas-types';

export default function PricingPage() {
  const router = useRouter();
  const { plans, user, workspace, token, notify } = useAuth();
  const [busyPlan, setBusyPlan] = useState<string | null>(null);

  async function handleSelectPlan(plan: PlanDef) {
    if (!user || !token) {
      router.push('/register');
      return;
    }
    if (workspace?.planTier === plan.id) return;
    setBusyPlan(plan.id);
    const res = await apiRequest('/api/v1/billing/checkout', {
      method: 'POST',
      token,
      body: { planTier: plan.id },
    });
    setBusyPlan(null);
    if (res.ok) {
      notify(`Checkout initialized for ${plan.name}. Complete verification in Billing.`, 'success');
      router.push('/settings/billing');
    } else {
      notify('Unable to start checkout. Please try again in Billing.', 'error');
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicNavbar />
      <main className="mx-auto max-w-[1280px] px-4 py-16 sm:px-6 space-y-16">
        <div className="max-w-2xl space-y-3">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Commercial Plans
          </div>
          <h1 className="font-display text-4xl sm:text-5xl font-semibold tracking-tight">
            Transparent pricing backed by server-side entitlements.
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every workspace starts on Free with 10 clips/month. Quotas and plan upgrades are
            enforced on the server and activated only through signature-verified billing webhooks.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => {
            const isCurrent = workspace?.planTier === p.id;
            return (
              <div
                key={p.id}
                className={`rounded-lg border p-6 flex flex-col justify-between space-y-6 ${
                  p.highlighted ? 'border-primary bg-card' : 'border-border bg-card/60'
                }`}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="font-display text-lg font-semibold">{p.name}</span>
                    {isCurrent ? (
                      <Badge variant="secondary">Current Plan</Badge>
                    ) : p.highlighted ? (
                      <Badge>Recommended</Badge>
                    ) : null}
                  </div>
                  <div className="tabular-nums">
                    <span className="font-display text-4xl font-bold">${p.priceMonthlyUsd}</span>
                    <span className="text-xs text-muted-foreground"> / month</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{p.tagline}</p>

                  <div className="border-y border-border py-3 space-y-1.5 text-xs font-mono tabular-nums">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Monthly clips</span>
                      <span>{p.monthlyClipLimit.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Creators</span>
                      <span>{p.maxCreators}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Social accounts</span>
                      <span>{p.maxSocialAccounts}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">API keys</span>
                      <span>{p.apiKeysAllowed}</span>
                    </div>
                  </div>

                  <ul className="space-y-2 text-xs text-muted-foreground">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <Button
                  className="w-full"
                  variant={p.highlighted ? 'default' : 'outline'}
                  disabled={isCurrent || busyPlan === p.id}
                  onClick={() => handleSelectPlan(p)}
                >
                  {isCurrent
                    ? 'Active Plan'
                    : busyPlan === p.id
                      ? 'Opening Checkout...'
                      : user
                        ? `Upgrade to ${p.name}`
                        : `Start ${p.name}`}
                </Button>
              </div>
            );
          })}
        </div>

        {/* Quota Comparison Table */}
        <section className="space-y-4">
          <h2 className="font-display text-2xl font-semibold">Quota &amp; Capability Comparison</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-card font-mono text-muted-foreground">
                <tr>
                  <th className="p-3.5">Capability</th>
                  {plans.map((p) => (
                    <th key={p.id} className="p-3.5">{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                <tr>
                  <td className="p-3.5 font-medium">Monthly Clip Quota</td>
                  {plans.map((p) => <td key={p.id} className="p-3.5 font-mono">{p.monthlyClipLimit.toLocaleString()}</td>)}
                </tr>
                <tr>
                  <td className="p-3.5 font-medium">Tagged Creator Channels</td>
                  {plans.map((p) => <td key={p.id} className="p-3.5 font-mono">{p.maxCreators}</td>)}
                </tr>
                <tr>
                  <td className="p-3.5 font-medium">Linked Social Accounts</td>
                  {plans.map((p) => <td key={p.id} className="p-3.5 font-mono">{p.maxSocialAccounts}</td>)}
                </tr>
                <tr>
                  <td className="p-3.5 font-medium">Active Workspace API Keys</td>
                  {plans.map((p) => <td key={p.id} className="p-3.5 font-mono">{p.apiKeysAllowed}</td>)}
                </tr>
                <tr>
                  <td className="p-3.5 font-medium">Human Approval Gate &amp; Compliance</td>
                  {plans.map((p) => <td key={p.id} className="p-3.5">Included</td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div className="rounded-lg border border-border bg-card p-5 flex flex-wrap items-start gap-3 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-medium text-foreground">Billing Transparency</div>
            <p>
              Monthly billing, paid securely through Stripe. Your plan changes only after Stripe
              confirms the payment, and you can cancel any time from Billing.
            </p>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
