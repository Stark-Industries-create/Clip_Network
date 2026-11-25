'use client';

import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { BillingView } from '@/components/SaasAccountViews';

export default function SettingsBillingPage() {
  const { token, workspace, plans, refreshSession, notify } = useAuth();

  return (
    <AppShell
      title="Billing & Subscription"
      subtitle="Choose a plan, pay securely with Stripe and see your invoices."
      breadcrumb="SETTINGS / BILLING"
    >
      {token && workspace && (
        <BillingView
          token={token}
          workspace={workspace}
          plans={plans}
          onWorkspaceUpdated={refreshSession}
          onNotify={(m) => notify(m, 'success')}
          onError={(m) => notify(m, 'error')}
        />
      )}
    </AppShell>
  );
}
