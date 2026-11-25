'use client';

import Link from 'next/link';

/** Shown when a page crashes, instead of a blank screen. */
export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div role="alert" className="max-w-sm text-center space-y-3">
        <h1 className="font-display text-2xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">This page could not load. Try again; if it keeps happening, contact support.</p>
        <div className="flex justify-center gap-3 pt-2 text-sm">
          <button type="button" onClick={reset} className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground">Try again</button>
          <Link href="/support" className="rounded-md border border-border px-4 py-2">Contact support</Link>
        </div>
      </div>
    </main>
  );
}
