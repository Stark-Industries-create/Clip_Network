'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/saas-types';

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** "Continue with Google". Hidden until the platform admin has set up Google sign-in. */
export function GoogleSignInButton({ label = 'Continue with Google' }: { label?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void apiRequest<{ enabled: boolean }>('/api/v1/auth/google/status')
      .then((res) => { if (active) setEnabled(Boolean(res.ok && res.json.data?.enabled)); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  if (!enabled) return null;

  async function start() {
    setBusy(true);
    setError('');
    const res = await apiRequest<{ url: string }>('/api/v1/auth/google/start', { method: 'POST' }).catch(() => null);
    if (res?.ok && res.json.data?.url) {
      window.location.assign(res.json.data.url);
      return;
    }
    setError(typeof res?.json.error === 'string' ? res.json.error : 'Google sign-in could not start. Try again.');
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <Button type="button" variant="outline" className="w-full gap-2" disabled={busy} onClick={() => void start()}>
        <GoogleMark /> {busy ? 'Opening Google…' : label}
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-3 text-[11px] uppercase text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
