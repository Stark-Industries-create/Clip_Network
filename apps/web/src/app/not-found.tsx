import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Page not found · Clip Network' };

export default function NotFound() {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-3">
        <p className="font-mono text-xs text-muted-foreground">404</p>
        <h1 className="font-display text-2xl font-semibold">This page does not exist</h1>
        <p className="text-sm text-muted-foreground">The link may be old, or the item may have been deleted.</p>
        <div className="flex justify-center gap-3 pt-2 text-sm">
          <Link href="/dashboard" className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground">Go to dashboard</Link>
          <Link href="/" className="rounded-md border border-border px-4 py-2">Home</Link>
        </div>
      </div>
    </main>
  );
}
