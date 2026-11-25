'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Clapperboard, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type SaasUser, type SaasWorkspace } from '@/lib/saas-types';

export default function LoginPage() {
  const router = useRouter();
  const { setSession, notify } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiRequest<{
      token: string;
      user: SaasUser;
      workspace: SaasWorkspace;
    }>('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password, rememberMe },
    });
    setBusy(false);
    if (!res.ok || !res.json.data) {
      setError(
        typeof res.json.error === 'string'
          ? res.json.error
          : 'Invalid credentials or server error.',
      );
      return;
    }
    await setSession(res.json.data);
    notify('Signed in successfully.', 'success');
    router.push(res.json.data.user.onboardingCompleted ? '/dashboard' : '/onboarding');
  }

  return (
    <div className="min-h-screen bg-background text-foreground grid lg:grid-cols-12">
      {/* Left Brand Panel (Desktop) */}
      <div className="hidden lg:flex lg:col-span-5 flex-col justify-between border-r border-border bg-card p-10">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Clapperboard className="h-4 w-4" />
          </div>
          <span className="font-display text-base font-semibold">Clip Network</span>
        </Link>

        <div className="space-y-4 max-w-sm">
          <div className="font-mono text-xs uppercase text-primary">Creator Distribution OS</div>
          <h2 className="font-display text-3xl font-semibold tracking-tight leading-tight">
            One workspace for clipping, compliance, and multi-platform release.
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Every workspace is tenant-isolated with server-enforced quotas, AES-256-GCM encrypted
            OAuth vaults, and human approval by default.
          </p>
        </div>

        <div className="text-[11px] font-mono text-muted-foreground">
          © {new Date().getFullYear()} Clip Network
        </div>
      </div>

      {/* Right Focused Form */}
      <div className="lg:col-span-7 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="lg:hidden">
            <Link href="/" className="inline-flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Clapperboard className="h-3.5 w-3.5" />
              </div>
              <span className="font-display text-sm font-semibold">Clip Network</span>
            </Link>
          </div>

          <div className="space-y-1.5">
            <h1 className="font-display text-2xl font-semibold">Log in to your workspace</h1>
            <p className="text-xs text-muted-foreground">
              Enter your account email and password to continue.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <GoogleSignInButton />
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@agency.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link href="/forgot-password" className="text-xs text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <span>Keep me signed in for 30 days</span>
            </label>

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Signing in...' : 'Log in'}
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            Don&apos;t have a workspace?{' '}
            <Link href="/register" className="font-medium text-primary hover:underline">
              Create free account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
