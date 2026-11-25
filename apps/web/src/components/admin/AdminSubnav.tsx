'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ADMIN_TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/workspaces', label: 'Workspaces' },
  { href: '/admin/integrations', label: 'Integrations' },
  { href: '/admin/subscriptions', label: 'Revenue & Plans' },
  { href: '/admin/operations', label: 'Jobs & Ops' },
  { href: '/admin/security', label: 'Security & Audit' },
  { href: '/admin/support', label: 'Support Triage' },
];

export function AdminSubnav() {
  const pathname = usePathname();
  return (
    <div className="mb-6 flex flex-wrap gap-1.5 border-b border-border pb-3">
      {ADMIN_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
