import React from 'react';
import { PublicFooter, PublicNavbar } from '@/components/layout/PublicChrome';

/** Contact for legal and privacy requests. Set NEXT_PUBLIC_LEGAL_EMAIL before launch. */
export const LEGAL_EMAIL = process.env.NEXT_PUBLIC_LEGAL_EMAIL || 'support@clipnetwork.app';
export const LEGAL_UPDATED = '25 November 2026';

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicNavbar />
      <main className="mx-auto max-w-[760px] px-4 py-16 sm:px-6">
        <h1 className="font-display text-3xl font-semibold">{title}</h1>
        <p className="mt-2 text-xs text-muted-foreground">Last updated {LEGAL_UPDATED}</p>
        <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_a]:text-primary [&_a]:underline">
          {children}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
