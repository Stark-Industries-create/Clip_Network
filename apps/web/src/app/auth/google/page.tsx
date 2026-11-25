'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type SaasUser, type SaasWorkspace } from '@/lib/saas-types';

/** Google returns here after sign-in; the code is exchanged by the API and a session starts. */
export default function GoogleCallbackPage() {
  const router = useRouter();
  const { setSession, notify } = useAuth();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    window.history.replaceState(null, '', url.pathname);
    if (url.searchParams.has('error') || !state || !code) {
      setError('Google sign-in was cancelled.');
      return;
    }
    void (async () => {
      const res = await apiRequest<{ token: string; created: boolean; user: SaasUser; workspace: SaasWorkspace }>(
        '/api/v1/auth/google/complete', { method: 'POST', body: { state, code } }).catch(() => null);
      if (!res?.ok || !res.json.data) {
        setError(typeof res?.json.error === 'string' ? res.json.error : 'Google sign-in failed. Try again.');
        return;
      }
      await setSession(res.json.data);
      notify(res.json.data.created ? 'Account created with Google.' : 'Signed in with Google.', 'success');
      router.replace(res.json.data.user.onboardingCompleted ? '/dashboard' : '/onboarding');
    })();
  }, [notify, router, setSession]);

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <title>Signing in · Clip Network</title>
      <div className="max-w-sm space-y-3 text-center">
        {error ? (
          <>
            <h1 className="font-display text-xl font-semibold">Could not sign in</h1>
            <p role="alert" className="text-sm text-muted-foreground">{error}</p>
            <Link href="/login" className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Back to log in</Link>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">Signing you in with Google…</p>
        )}
      </div>
    </main>
  );
}
