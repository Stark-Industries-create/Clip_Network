'use client';

import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Clapperboard,
  KeyRound,
  Lock,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  Video,
  Volume2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { apiRequest, type PlanDef, type SaasUser, type SaasWorkspace } from '@/lib/saas-types';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';

type AuthMode = 'LANDING' | 'LOGIN' | 'REGISTER' | 'FORGOT' | 'RESET';

interface LandingAndAuthProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  plans: PlanDef[];
  onAuthenticated: (payload: {
    token: string;
    user: SaasUser;
    workspace: SaasWorkspace;
    devVerificationToken?: string;
  }) => void;
}

export function LandingAndAuth({
  theme,
  onToggleTheme,
  plans,
  onAuthenticated,
}: LandingAndAuthProps) {
  const [mode, setMode] = useState<AuthMode>('LANDING');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // Register state
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regWorkspace, setRegWorkspace] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Login state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  // Forgot/Reset state
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    const res = await apiRequest<{
      token: string;
      user: SaasUser;
      workspace: SaasWorkspace;
      devVerificationToken?: string;
    }>('/api/v1/auth/register', {
      method: 'POST',
      body: {
        name: regName,
        email: regEmail,
        password: regPassword,
        workspaceName: regWorkspace || undefined,
        termsAccepted,
      },
    });
    setBusy(false);
    if (!res.ok || !res.json.data) {
      setErrorMsg(typeof res.json.error === 'string' ? res.json.error : 'Registration failed. Check all fields.');
      return;
    }
    onAuthenticated(res.json.data);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    const res = await apiRequest<{
      token: string;
      user: SaasUser;
      workspace: SaasWorkspace;
    }>('/api/v1/auth/login', {
      method: 'POST',
      body: { email: loginEmail, password: loginPassword, rememberMe },
    });
    setBusy(false);
    if (!res.ok || !res.json.data) {
      setErrorMsg(typeof res.json.error === 'string' ? res.json.error : 'Invalid email or password.');
      return;
    }
    onAuthenticated(res.json.data);
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    const res = await apiRequest<{ message: string; devResetToken?: string }>(
      '/api/v1/auth/forgot-password',
      { method: 'POST', body: { email: forgotEmail } },
    );
    setBusy(false);
    if (res.ok && res.json.data) {
      setInfoMsg(res.json.data.message);
      if (res.json.data.devResetToken) {
        setResetToken(res.json.data.devResetToken);
        setMode('RESET');
      }
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    const res = await apiRequest('/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token: resetToken, newPassword },
    });
    setBusy(false);
    if (!res.ok) {
      setErrorMsg(typeof res.json.error === 'string' ? res.json.error : 'Reset failed.');
      return;
    }
    setInfoMsg('Password updated. Sign in with your new password.');
    setMode('LOGIN');
  }

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-x-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 opacity-90 dark:opacity-100"
        style={{
          background:
            theme === 'dark'
              ? 'radial-gradient(65% 45% at 50% 0%, rgba(212,255,0,0.09) 0%, rgba(9,9,11,0) 70%)'
              : 'radial-gradient(70% 50% at 20% 0%, rgba(251,146,60,0.22) 0%, transparent 55%), radial-gradient(60% 45% at 85% 5%, rgba(139,92,246,0.18) 0%, transparent 55%)',
        }}
      />

      {/* Top Public Nav */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1380px] items-center justify-between px-4 sm:px-6">
          <button
            type="button"
            onClick={() => {
              setMode('LANDING');
              setErrorMsg(null);
            }}
            className="flex items-center gap-3 text-left"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Clapperboard className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-[15px] font-semibold tracking-tight">
                  Clip Network
                </span>
                <span className="rounded-full border border-border bg-secondary/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  SaaS v2.0
                </span>
              </div>
              <p className="hidden text-[11px] text-muted-foreground sm:block">
                Multi-Tenant Creator Clipping &amp; Distribution Platform
              </p>
            </div>
          </button>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleTheme}
              title={theme === 'dark' ? 'Switch to Editorial Light' : 'Switch to Obsidian Dark'}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setMode('LOGIN'); setErrorMsg(null); }}>
              Sign In
            </Button>
            <Button size="sm" onClick={() => { setMode('REGISTER'); setErrorMsg(null); }}>
              Start Free <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {mode === 'LANDING' ? (
        <main className="mx-auto max-w-[1380px] px-4 py-14 sm:px-6 space-y-24">
          {/* Hero */}
          <section className="mx-auto max-w-4xl text-center space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/80 px-3.5 py-1.5 text-xs text-muted-foreground backdrop-blur">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span>Voice-Synced Captions • Procedural SFX • Multi-Tenant RBAC • Human Approval Gate</span>
            </div>
            <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-6xl leading-[1.06]">
              Turn live streams into{' '}
              <span className="bg-gradient-to-r from-primary via-emerald-400 to-cyan-400 dark:from-[#D4FF00] dark:via-[#a3e635] dark:to-[#34d399] bg-clip-text text-transparent">
                compliant viral clips
              </span>{' '}
              at agency scale.
            </h1>
            <p className="mx-auto max-w-2xl text-base text-muted-foreground sm:text-lg">
              Tag creators, enforce campaign compliance rules automatically, align word-level subtitles
              to real speech, synthesize punchy SFX, and route approved shorts to Instagram Reels,
              TikTok, YouTube Shorts, and X.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <Button size="lg" className="h-11 px-7 font-semibold" onClick={() => setMode('REGISTER')}>
                Create Free Studio <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" className="h-11 px-7" onClick={() => setMode('LOGIN')}>
                Sign In to Workspace
              </Button>
            </div>
          </section>

          {/* 3-Pillar Architecture */}
          <section className="grid gap-5 md:grid-cols-3">
            {[
              {
                icon: Video,
                title: 'Voice-Aligned Clip Engine',
                desc: 'FFmpeg silence-aware subtitle windows, 4 creator caption presets, and split-facecam 9:16 framing.',
              },
              {
                icon: Volume2,
                title: 'Procedural SFX & Compliance Gate',
                desc: 'Zero-dependency procedural whoosh/pop/boom synthesis plus automated topic & disqualifier scoring.',
              },
              {
                icon: ShieldCheck,
                title: 'Multi-Tenant SaaS & Encrypted Vault',
                desc: 'Strict workspace isolation, AES-256-GCM OAuth token encryption, API keys, and HMAC-verified billing.',
              },
            ].map((item) => (
              <Card key={item.title} className="border-border/70 bg-card/80 backdrop-blur">
                <CardHeader>
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <CardTitle className="font-display text-lg">{item.title}</CardTitle>
                  <CardDescription>{item.desc}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </section>

          {/* Live 4-Tier Commercial Pricing */}
          <section id="pricing" className="space-y-8">
            <div className="text-center space-y-2">
              <Badge variant="outline" className="px-3 py-1">Transparent SaaS Pricing</Badge>
              <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
                Built for solo clippers and full media networks
              </h2>
              <p className="text-sm text-muted-foreground">
                Start free with 10 clips/month. Upgrade anytime with server-verified billing.
              </p>
            </div>
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
              {plans.map((plan) => (
                <Card
                  key={plan.id}
                  className={
                    plan.highlighted
                      ? 'border-primary/70 bg-card shadow-lg ring-1 ring-primary/30'
                      : 'border-border/70 bg-card/70'
                  }
                >
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="font-display text-lg">{plan.name}</CardTitle>
                      {plan.highlighted && <Badge>Most Popular</Badge>}
                    </div>
                    <div className="pt-2">
                      <span className="font-display text-3xl font-bold">${plan.priceMonthlyUsd}</span>
                      <span className="text-xs text-muted-foreground"> / month</span>
                    </div>
                    <CardDescription className="pt-1 text-xs">{plan.tagline}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ul className="space-y-2 text-xs text-muted-foreground">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-start gap-2">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                    <Button
                      className="w-full"
                      variant={plan.highlighted ? 'default' : 'outline'}
                      onClick={() => setMode('REGISTER')}
                    >
                      Get Started with {plan.name}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        </main>
      ) : (
        /* Auth Screens: Register / Login / Forgot / Reset */
        <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center justify-center px-4 py-12">
          <Card className="w-full border-border/80 bg-card/95 shadow-2xl backdrop-blur-xl">
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
                {mode === 'REGISTER' ? (
                  <Zap className="h-5 w-5" />
                ) : mode === 'LOGIN' ? (
                  <Lock className="h-5 w-5" />
                ) : (
                  <KeyRound className="h-5 w-5" />
                )}
              </div>
              <CardTitle className="font-display text-xl">
                {mode === 'REGISTER' && 'Create your Clip Network Studio'}
                {mode === 'LOGIN' && 'Sign in to Clip Network'}
                {mode === 'FORGOT' && 'Reset your password'}
                {mode === 'RESET' && 'Set a new password'}
              </CardTitle>
              <CardDescription>
                {mode === 'REGISTER' && 'Provision an isolated multi-tenant workspace in seconds.'}
                {mode === 'LOGIN' && 'Enter your account credentials to access your studio.'}
                {mode === 'FORGOT' && 'We will issue a secure expiring password reset token.'}
                {mode === 'RESET' && 'Enter your reset token and choose a strong new password.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {errorMsg && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {errorMsg}
                </div>
              )}
              {infoMsg && (
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
                  {infoMsg}
                </div>
              )}

              {mode === 'REGISTER' && (
                <>
                <GoogleSignInButton label="Sign up with Google" />
                <form onSubmit={handleRegister} className="space-y-3">
                  <fieldset disabled={!hydrated} className="space-y-3 min-w-0">
                    <div className="space-y-1">
                      <Label htmlFor="reg-name">Full Name</Label>
                      <Input
                        id="reg-name"
                        required
                        placeholder="Alex Founder"
                        value={regName}
                        onChange={(e) => setRegName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="reg-email">Work Email</Label>
                      <Input
                        id="reg-email"
                        type="email"
                        required
                        placeholder="alex@studio.io"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="reg-ws">Workspace / Agency Name</Label>
                      <Input
                        id="reg-ws"
                        placeholder="Viral Clips Agency"
                        value={regWorkspace}
                        onChange={(e) => setRegWorkspace(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="reg-pw">Password (8+ chars, letter + number)</Label>
                      <Input
                        id="reg-pw"
                        type="password"
                        required
                        minLength={8}
                        placeholder="••••••••"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                      />
                    </div>
                    <label className="flex items-start gap-2 text-xs text-muted-foreground pt-1">
                      <input
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={(e) => setTermsAccepted(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>I agree to the Terms of Service and Privacy Policy.</span>
                    </label>
                    <Button type="submit" className="w-full" disabled={busy || !termsAccepted}>
                      {busy ? 'Creating workspace...' : 'Create Account'}
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">
                      Already have an account?{' '}
                      <button
                        type="button"
                        className="font-medium text-primary hover:underline"
                        onClick={() => { setMode('LOGIN'); setErrorMsg(null); }}
                      >
                        Sign in
                      </button>
                    </p>
                  </fieldset>
                </form>
                </>
              )}

              {mode === 'LOGIN' && (
                <>
                <GoogleSignInButton />
                <form onSubmit={handleLogin} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="login-email">Email</Label>
                    <Input
                      id="login-email"
                      type="email"
                      required
                      placeholder="alex@studio.io"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="login-pw">Password</Label>
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => { setMode('FORGOT'); setErrorMsg(null); }}
                      >
                        Forgot password?
                      </button>
                    </div>
                    <Input
                      id="login-pw"
                      type="password"
                      required
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                    />
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
                    {busy ? 'Signing in...' : 'Sign In'}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    New to Clip Network?{' '}
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => { setMode('REGISTER'); setErrorMsg(null); }}
                    >
                      Create an account
                    </button>
                  </p>
                </form>
                </>
              )}

              {mode === 'FORGOT' && (
                <form onSubmit={handleForgot} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="forgot-email">Account Email</Label>
                    <Input
                      id="forgot-email"
                      type="email"
                      required
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? 'Requesting token...' : 'Send Reset Token'}
                  </Button>
                  <Button type="button" variant="ghost" className="w-full" onClick={() => setMode('LOGIN')}>
                    Back to Sign In
                  </Button>
                </form>
              )}

              {mode === 'RESET' && (
                <form onSubmit={handleReset} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="reset-tok">Reset Token</Label>
                    <Input
                      id="reset-tok"
                      required
                      value={resetToken}
                      onChange={(e) => setResetToken(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reset-pw">New Password</Label>
                    <Input
                      id="reset-pw"
                      type="password"
                      required
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? 'Updating...' : 'Reset Password'}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </main>
      )}
    </div>
  );
}
