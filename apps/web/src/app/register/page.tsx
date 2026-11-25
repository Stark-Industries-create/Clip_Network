'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Clapperboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { useAuth } from '@/components/providers/AuthProvider';
import { apiRequest, type SaasUser, type SaasWorkspace } from '@/lib/saas-types';

export default function RegisterPage() {
  const router = useRouter();
  const { setSession, notify } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasMinLen = password.length >= 8;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const pwMatches = password.length > 0 && password === confirmPassword;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasMinLen || !hasLetter || !hasNumber) {
      setError('Password must be at least 8 characters and include a letter and a number.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await apiRequest<{
      token: string;
      user: SaasUser;
      workspace: SaasWorkspace;
      devVerificationToken?: string;
    }>('/api/v1/auth/register', {
      method: 'POST',
      body: {
        name,
        email,
        password,
        workspaceName: workspaceName.trim() || undefined,
        termsAccepted,
      },
    });
    setBusy(false);
    if (!res.ok || !res.json.data) {
      setError(
        typeof res.json.error === 'string'
          ? res.json.error
          : 'Registration failed. Please check your inputs.',
      );
      return;
    }
    await setSession(res.json.data);
    notify('Workspace created. Complete onboarding to configure your first creator.', 'success');
    router.push('/onboarding');
  }

  return (
    <div className="min-h-screen bg-background text-foreground grid lg:grid-cols-12">
      <div className="hidden lg:flex lg:col-span-5 flex-col justify-between border-r border-border bg-card p-10">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Clapperboard className="h-4 w-4" />
          </div>
          <span className="font-display text-base font-semibold">Clip Network</span>
        </Link>

        <div className="space-y-4 max-w-sm">
          <div className="font-mono text-xs uppercase text-primary">Free Tier Included</div>
          <h2 className="font-display text-3xl font-semibold tracking-tight leading-tight">
            Launch your multi-tenant clipping workspace in 60 seconds.
          </h2>
          <ul className="space-y-2 text-xs text-muted-foreground">
            <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" /> 10 AI-aligned clips / month free</li>
            <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" /> Voice-synced captions &amp; procedural SFX</li>
            <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" /> Campaign compliance &amp; human approval gate</li>
          </ul>
        </div>

        <div className="text-[11px] font-mono text-muted-foreground">
          No credit card required to start
        </div>
      </div>

      <div className="lg:col-span-7 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-5">
          <div className="space-y-1">
            <h1 className="font-display text-2xl font-semibold">Create your workspace</h1>
            <p className="text-xs text-muted-foreground">
              Start on Free and upgrade anytime as your clipping network grows.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <GoogleSignInButton label="Sign up with Google" />
          <form onSubmit={onSubmit} className="space-y-3.5">
            <fieldset disabled={!hydrated} className="space-y-3 min-w-0">
              <div className="space-y-1">
                <Label htmlFor="name">Full Name</Label>
                <Input id="name" required placeholder="Alex Founder" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div className="space-y-1">
                <Label htmlFor="email">Work Email</Label>
                <Input id="email" type="email" required placeholder="alex@agency.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>

              <div className="space-y-1">
                <Label htmlFor="ws">Workspace Name (optional)</Label>
                <Input id="ws" placeholder="Viral Clips Agency" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
              </div>

              <div className="space-y-1">
                <Label htmlFor="pw">Password</Label>
                <Input id="pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="flex flex-wrap gap-3 pt-1 text-[11px] font-mono">
                  <span className={hasMinLen ? 'text-primary' : 'text-muted-foreground'}>8+ chars</span>
                  <span className={hasLetter ? 'text-primary' : 'text-muted-foreground'}>1 letter</span>
                  <span className={hasNumber ? 'text-primary' : 'text-muted-foreground'}>1 number</span>
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="cpw">Confirm Password</Label>
                <Input id="cpw" type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                {confirmPassword.length > 0 && !pwMatches && (
                  <p className="text-[11px] text-destructive">Passwords do not match.</p>
                )}
              </div>

              <label className="flex items-start gap-2 text-xs text-muted-foreground pt-1">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I accept the <Link href="/terms" className="underline">Terms of Service</Link> and{' '}
                  <Link href="/privacy" className="underline">Privacy Policy</Link>.
                </span>
              </label>

              <Button type="submit" className="w-full" disabled={busy || !termsAccepted}>
                {busy ? 'Creating workspace...' : 'Create Account'}
              </Button>
            </fieldset>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
