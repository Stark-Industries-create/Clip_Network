'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  BarChart3,
  BookOpen,
  CheckSquare,
  Clapperboard,
  CreditCard,
  Film,
  Gauge,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Link2,
  LogOut,
  Menu,
  Moon,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/components/providers/AuthProvider';

interface AppShellProps {
  title: string;
  subtitle?: string;
  breadcrumb?: string;
  actions?: React.ReactNode;
  requireSuperAdmin?: boolean;
  children: React.ReactNode;
}

export function AppShell({
  title,
  subtitle,
  breadcrumb,
  actions,
  requireSuperAdmin = false,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { booting, user, workspace, workspaceRole, theme, toggleTheme, logout } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    document.title = `${title} · Clip Network`;
  }, [title]);

  useEffect(() => {
    if (booting) return;
    if (!user || !workspace) {
      router.replace('/login');
      return;
    }
    if (!user.onboardingCompleted && pathname !== '/onboarding') {
      router.replace('/onboarding');
      return;
    }
    if (requireSuperAdmin && user.systemRole !== 'SUPER_ADMIN') {
      router.replace('/dashboard');
    }
  }, [booting, user, workspace, pathname, requireSuperAdmin, router]);

  if (booting || !user || !workspace) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <span className="text-xs font-mono text-muted-foreground">Loading workspace...</span>
      </div>
    );
  }

  if (requireSuperAdmin && user.systemRole !== 'SUPER_ADMIN') {
    return null;
  }

  const pct = Math.min(
    100,
    Math.round((workspace.clipsUsedThisPeriod / Math.max(1, workspace.monthlyClipLimit)) * 100),
  );

  const sections = [
    {
      label: 'Operations',
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { href: '/clips/new', label: 'Ingest', icon: Plus },
        { href: '/clips', label: 'Clip Library', icon: Film },
        { href: '/approvals', label: 'Approval Queue', icon: CheckSquare },
        { href: '/publishing', label: 'Publishing', icon: Send },
      ],
    },
    {
      label: 'Distribution',
      items: [
        { href: '/creators', label: 'Creators', icon: Users },
        { href: '/campaigns', label: 'Compliance Rules', icon: ShieldCheck },
        { href: '/social-accounts', label: 'Social Accounts', icon: Link2 },
        { href: '/routes', label: 'Routing Rules', icon: GitBranch },
      ],
    },
    {
      label: 'Observability',
      items: [
        { href: '/analytics', label: 'Analytics', icon: BarChart3 },
        { href: '/activity', label: 'Executions', icon: Activity },
      ],
    },
    {
      label: 'Workspace & Billing',
      items: [
        { href: '/settings/billing', label: 'Billing & Plans', icon: CreditCard },
        { href: '/settings/usage', label: 'Usage & Quotas', icon: Gauge },
        { href: '/settings/api-keys', label: 'API Keys', icon: KeyRound },
        { href: '/settings/workspace', label: 'Settings', icon: Settings },
        { href: '/support', label: 'Support', icon: LifeBuoy },
        { href: '/docs', label: 'Documentation', icon: BookOpen },
      ],
    },
    ...(user.systemRole === 'SUPER_ADMIN'
      ? [
          {
            label: 'Platform Admin',
            items: [
              { href: '/admin', label: 'Control Center', icon: ShieldAlert },
              { href: '/admin/users', label: 'Users', icon: Users },
              { href: '/admin/workspaces', label: 'Workspaces', icon: LayoutDashboard },
              { href: '/admin/integrations', label: 'Integrations', icon: KeyRound },
              { href: '/admin/subscriptions', label: 'Revenue & Plans', icon: CreditCard },
              { href: '/admin/operations', label: 'Jobs & Ops', icon: Activity },
              { href: '/admin/security', label: 'Security & Audit', icon: ShieldCheck },
              { href: '/admin/support', label: 'Support Triage', icon: LifeBuoy },
            ],
          },
        ]
      : []),
  ];

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between bg-card border-r border-border">
      <div className="overflow-y-auto px-3 py-4 space-y-5">
        <div className="px-2 space-y-3">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Clapperboard className="h-3.5 w-3.5" />
            </div>
            <span className="font-display text-sm font-semibold tracking-tight">Clip Network</span>
          </Link>

          <div className="rounded-md border border-border bg-background/70 p-2.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium">{workspace.name}</span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                {workspace.planTier}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono tabular-nums">
              <span>{workspace.clipsUsedThisPeriod} / {workspace.monthlyClipLimit} clips</span>
              <span>{pct}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            {pct >= 80 && workspace.planTier !== 'ENTERPRISE' && (
              <Link
                href="/settings/billing"
                className="block pt-1 text-[11px] font-medium text-primary hover:underline"
              >
                Approaching limit — Upgrade plan →
              </Link>
            )}
          </div>
        </div>

        <nav className="space-y-4">
          {sections.map((section) => (
            <div key={section.label} className="space-y-1">
              <div className="px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {section.label}
              </div>
              {section.items.map((item) => {
                const Icon = item.icon;
                const active =
                  pathname === item.href ||
                  (item.href !== '/dashboard' &&
                    item.href !== '/clips' &&
                    item.href !== '/admin' &&
                    pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </div>

      <div className="border-t border-border p-3 space-y-2">
        <div className="flex items-center justify-between px-1">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{user.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {user.email} • {workspaceRole}
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start text-xs h-8"
          onClick={async () => {
            await logout();
            router.push('/login');
          }}
        >
          <LogOut className="mr-2 h-3.5 w-3.5" /> Sign Out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* React 19 hoists this into <head>; it outlives Next's site-wide default title on navigation. */}
      <title>{`${title} · Clip Network`}</title>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-60 shrink-0 sticky top-0 h-screen">{sidebarContent}</aside>

      {/* Mobile Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="w-64 h-full">{sidebarContent}</div>
          <button
            type="button"
            className="flex-1 bg-black/60"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
          />
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-md">
          {/* On phones the actions wrap below the title instead of squeezing it to nothing. */}
          <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-8 py-3">
            <div className="flex items-center gap-3 min-w-0 flex-1 basis-56">
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden shrink-0"
                onClick={() => setDrawerOpen((o) => !o)}
                aria-label="Toggle navigation"
              >
                {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </Button>
              <div className="min-w-0">
                {breadcrumb && (
                  <div className="text-[11px] font-mono text-muted-foreground">{breadcrumb}</div>
                )}
                <h1 className="font-display text-lg sm:text-xl font-semibold tracking-tight truncate">
                  {title}
                </h1>
                {subtitle && (
                  <p className="text-xs text-muted-foreground truncate hidden sm:block">{subtitle}</p>
                )}
              </div>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        </header>

        {!user.emailVerified && (
          <div className="border-b border-border bg-secondary/50 px-4 sm:px-8 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              Your email <strong className="text-foreground">{user.email}</strong> is not verified yet.
            </span>
            <Link href="/verify-email" className="font-medium text-primary hover:underline">
              Verify email →
            </Link>
          </div>
        )}

        <main className="flex-1 px-4 sm:px-8 py-6 max-w-[1360px] w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
