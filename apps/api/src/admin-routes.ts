import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  AdminOverridePlanSchema,
  AdminUpdateTicketSchema,
  SAAS_PLANS,
  type PlanTier,
} from '@clip-network/shared';
import { requireSuperAdmin } from './auth.js';
import { isStripeLiveConfigured } from './integrations/stripe.js';
import { isLiveEmailConfigured } from './integrations/email.js';
import { getS3StorageConfig } from './integrations/storage.js';

const ESTIMATED_COGS_PER_CLIP_USD = 0.013;

export function registerSuperAdminControlCenterRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  deps: {
    logAudit: (
      action: string,
      entityType: string,
      entityId: string,
      details: unknown,
      workspaceId?: string,
      userId?: string,
    ) => Promise<void>;
    executePublishPost: (postId: string, workspaceId: string, userId?: string) => Promise<unknown>;
  },
) {
  // 1. Master Platform Overview & BI Snapshot
  app.get('/api/v1/admin/control-center', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;

    const now = new Date();
    const [
      users,
      workspaces,
      activeSessionsCount,
      clips,
      posts,
      invoices,
      tickets,
      monitoredCreators,
      detectedVideosCount,
      latestSnapshots,
      funnelRaw,
    ] = await Promise.all([
      prisma.user.findMany({
        select: { status: true, emailVerifiedAt: true, onboardingCompleted: true },
      }),
      prisma.workspace.findMany({
        include: {
          members: { where: { role: 'OWNER' }, include: { user: { select: { email: true, name: true } } } },
          _count: { select: { clips: true, creators: true, socialAccounts: true, publishPosts: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.session.count({ where: { expiresAt: { gt: now } } }),
      prisma.clipJob.findMany({
        select: {
          executionStatus: true,
          compliancePassed: true,
          approvalStatus: true,
          durationMs: true,
        },
      }),
      prisma.publishPost.findMany({
        select: { status: true, executionMode: true },
      }),
      prisma.subscriptionInvoice.findMany({
        orderBy: { createdAt: 'desc' },
        include: { workspace: { select: { name: true, slug: true } } },
        take: 100,
      }),
      prisma.supportTicket.findMany({
        select: { status: true, priority: true },
      }),
      prisma.creatorAccount.findMany({
        where: { autoMonitorEnabled: true },
        select: { lastPolledAt: true },
      }),
      prisma.channelVideo.count(),
      prisma.postMetricSnapshot.findMany({
        select: { views: true, likes: true, shares: true, sourceMode: true },
      }),
      prisma.conversionEvent.groupBy({
        by: ['eventName'],
        _count: { eventName: true },
      }),
    ]);

    const totalUsers = users.length;
    const activeUsers = users.filter((u) => u.status === 'ACTIVE').length;
    const suspendedUsers = users.filter((u) => u.status === 'SUSPENDED').length;
    const verifiedUsers = users.filter((u) => Boolean(u.emailVerifiedAt)).length;

    const totalWorkspaces = workspaces.length;
    const payingWorkspaces = workspaces.filter(
      (w) => w.planTier !== 'FREE' && w.subscriptionStatus === 'ACTIVE',
    ).length;
    const pastDueWorkspaces = workspaces.filter((w) => w.subscriptionStatus === 'PAST_DUE').length;

    const mrrUsd = workspaces.reduce((sum, w) => {
      if (w.subscriptionStatus !== 'ACTIVE') return sum;
      const plan = SAAS_PLANS[(w.planTier as PlanTier) ?? 'FREE'];
      return sum + (plan?.priceMonthlyUsd ?? 0);
    }, 0);

    const collectedRevenueUsd =
      Math.round(
        invoices
          .filter((inv) => inv.status === 'PAID')
          .reduce((sum, inv) => sum + inv.amountCents, 0),
      ) / 100;

    // Plan Distribution & Unit Economics
    const planEconomics = (Object.keys(SAAS_PLANS) as PlanTier[]).map((tier) => {
      const planDef = SAAS_PLANS[tier];
      const tierWs = workspaces.filter((w) => w.planTier === tier);
      const activeTierWs = tierWs.filter((w) => w.subscriptionStatus === 'ACTIVE');
      const tierMrr = activeTierWs.length * planDef.priceMonthlyUsd;
      const clipsUsed = tierWs.reduce((s, w) => s + w.clipsUsedThisPeriod, 0);
      const estCogsUsd = Math.round(clipsUsed * ESTIMATED_COGS_PER_CLIP_USD * 100) / 100;
      const grossProfitUsd = Math.round((tierMrr - estCogsUsd) * 100) / 100;
      return {
        tier,
        name: planDef.name,
        workspaces: tierWs.length,
        activeWorkspaces: activeTierWs.length,
        mrrUsd: tierMrr,
        clipsUsed,
        estCogsUsd,
        grossProfitUsd,
      };
    });

    // Pipeline Health
    const totalClips = clips.length;
    const completedClips = clips.filter((c) => c.executionStatus === 'COMPLETED').length;
    const failedClips = clips.filter((c) => c.executionStatus === 'FAILED').length;
    const pendingApprovalClips = clips.filter((c) => c.approvalStatus === 'AWAITING_APPROVAL').length;
    const compliancePassRatePct =
      totalClips > 0
        ? Math.round((clips.filter((c) => c.compliancePassed).length / totalClips) * 100)
        : 0;
    const avgClipDurationMs =
      totalClips > 0
        ? Math.round(clips.reduce((s, c) => s + c.durationMs, 0) / totalClips)
        : 0;

    const totalPosts = posts.length;
    const publishedLivePosts = posts.filter((p) => p.status === 'PUBLISHED_LIVE').length;
    const publishedSandboxPosts = posts.filter((p) => p.status === 'PUBLISHED_SANDBOX').length;
    const failedPosts = posts.filter((p) => p.status === 'FAILED').length;
    const blockedPosts = posts.filter((p) => p.status === 'BLOCKED').length;

    const totalTrackedViews = latestSnapshots.reduce((s, x) => s + x.views, 0);
    const estStorageMb = Math.round(totalClips * 24 * 10) / 10; // ~24MB/rendered vertical short estimate when media stored

    // Churn Risk & Upgrade Pressure Watchlist
    const watchlist = workspaces
      .map((w) => {
        const quotaPct = Math.round((w.clipsUsedThisPeriod / Math.max(1, w.monthlyClipLimit)) * 100);
        let signal: 'PAST_DUE' | 'CANCELLED' | 'QUOTA_PRESSURE' | null = null;
        if (w.subscriptionStatus === 'PAST_DUE') signal = 'PAST_DUE';
        else if (w.subscriptionStatus === 'CANCELLED') signal = 'CANCELLED';
        else if (quotaPct >= 80) signal = 'QUOTA_PRESSURE';
        return signal
          ? {
              workspaceId: w.id,
              workspaceName: w.name,
              ownerEmail: w.members[0]?.user.email ?? '—',
              planTier: w.planTier,
              subscriptionStatus: w.subscriptionStatus,
              quotaPct,
              clipsUsed: w.clipsUsedThisPeriod,
              monthlyLimit: w.monthlyClipLimit,
              signal,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    const lastPollTimestamp = monitoredCreators
      .map((c) => c.lastPolledAt?.getTime() ?? 0)
      .reduce((max, t) => Math.max(max, t), 0);

    return {
      success: true,
      data: {
        kpis: {
          totalUsers,
          activeUsers,
          suspendedUsers,
          verifiedUsers,
          totalWorkspaces,
          payingWorkspaces,
          pastDueWorkspaces,
          mrrUsd,
          collectedRevenueUsd,
          activeSessionsCount,
          openTickets: tickets.filter((t) => t.status === 'OPEN').length,
          highPriorityOpenTickets: tickets.filter((t) => t.status === 'OPEN' && t.priority === 'HIGH').length,
          monitoredCreatorsCount: monitoredCreators.length,
          detectedVideosCount,
          totalClips,
          completedClips,
          failedClips,
          pendingApprovalClips,
          compliancePassRatePct,
          avgClipDurationMs,
          totalPosts,
          publishedLivePosts,
          publishedSandboxPosts,
          failedPosts,
          blockedPosts,
          totalTrackedViews,
          estStorageMb,
        },
        planEconomics,
        watchlist,
        invoices: invoices.slice(0, 25),
        funnel: funnelRaw.map((f) => ({ eventName: f.eventName, count: f._count.eventName })),
        integrations: [
          { name: 'Database', mode: 'CONNECTED', live: true, detail: 'Prisma ORM operational' },
          {
            name: 'Stripe Billing',
            mode: isStripeLiveConfigured() ? 'STRIPE_LIVE' : 'NOT_CONFIGURED',
            live: isStripeLiveConfigured(),
            detail: isStripeLiveConfigured()
              ? 'Stripe connected'
              : 'Add Stripe keys in Integrations',
          },
          {
            name: 'Resend Email',
            mode: isLiveEmailConfigured() ? 'RESEND_LIVE' : 'SANDBOX_LOG',
            live: isLiveEmailConfigured(),
            detail: isLiveEmailConfigured()
              ? 'Resend REST API configured'
              : 'Token-redacted sandbox logging',
          },
          {
            name: 'Postiz Publishing',
            mode: process.env['POSTIZ_API_KEY']?.trim() ? 'LIVE_OAUTH' : 'SANDBOX_SIMULATED',
            live: Boolean(process.env['POSTIZ_API_KEY']?.trim()),
            detail: process.env['POSTIZ_API_KEY']?.trim()
              ? 'Live social distribution active'
              : 'Idempotent sandbox delivery mode',
          },
          {
            name: 'S3 Object Storage',
            mode: getS3StorageConfig() ? 'S3_LIVE' : 'LOCAL_SANDBOX',
            live: Boolean(getS3StorageConfig()),
            detail: getS3StorageConfig()
              ? `Bucket: ${getS3StorageConfig()?.bucket}`
              : 'SigV4 ready; awaiting S3_* env vars',
          },
          {
            name: 'Channel Monitor Worker',
            mode: lastPollTimestamp > 0 ? 'POLLING_ACTIVE' : 'IDLE',
            live: lastPollTimestamp > 0,
            detail:
              lastPollTimestamp > 0
                ? `Last poll: ${new Date(lastPollTimestamp).toISOString()}`
                : 'No channel polls recorded yet',
          },
        ],
      },
    };
  });

  // 2. Tenant Workspaces Directory & Manual Plan Override
  app.get('/api/v1/admin/workspaces', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const workspaces = await prisma.workspace.findMany({
      include: {
        members: { where: { role: 'OWNER' }, include: { user: { select: { email: true, name: true } } } },
        _count: { select: { members: true, creators: true, socialAccounts: true, clips: true, publishPosts: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      success: true,
      data: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        planTier: w.planTier,
        subscriptionStatus: w.subscriptionStatus,
        billingProviderMode: w.billingProviderMode,
        clipsUsedThisPeriod: w.clipsUsedThisPeriod,
        monthlyClipLimit: w.monthlyClipLimit,
        ownerEmail: w.members[0]?.user.email ?? '—',
        ownerName: w.members[0]?.user.name ?? '—',
        counts: w._count,
        createdAt: w.createdAt,
      })),
    };
  });

  app.patch('/api/v1/admin/workspaces/:workspaceId/plan', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const { workspaceId } = request.params as { workspaceId: string };
    const parsed = AdminOverridePlanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const planDef = SAAS_PLANS[parsed.data.planTier];
    const updated = await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        planTier: planDef.id,
        monthlyClipLimit: planDef.monthlyClipLimit,
        subscriptionStatus: parsed.data.subscriptionStatus,
      },
    });
    await deps.logAudit(
      'ADMIN_WORKSPACE_PLAN_OVERRIDDEN',
      'Workspace',
      workspaceId,
      { planTier: planDef.id, subscriptionStatus: parsed.data.subscriptionStatus },
      workspaceId,
      ctx.userId,
    );
    return { success: true, data: updated };
  });

  // 3. Operations Monitor: Clip Jobs, Channel Videos & Publish Posts + Safe Admin Retry
  app.get('/api/v1/admin/jobs', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;

    const [clips, posts, videos] = await Promise.all([
      prisma.clipJob.findMany({
        include: {
          workspace: { select: { name: true } },
          creator: { select: { displayName: true, handle: true, platform: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.publishPost.findMany({
        include: {
          workspace: { select: { name: true } },
          clipJob: { select: { title: true } },
          socialAccount: { select: { accountHandle: true, platform: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.channelVideo.findMany({
        include: {
          workspace: { select: { name: true } },
          creator: { select: { displayName: true, platform: true } },
        },
        orderBy: { detectedAt: 'desc' },
        take: 30,
      }),
    ]);

    return { success: true, data: { clips, posts, videos } };
  });

  app.post('/api/v1/admin/publish-posts/:postId/retry', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const { postId } = request.params as { postId: string };
    const post = await prisma.publishPost.findUnique({ where: { id: postId } });
    if (!post) return reply.status(404).send({ success: false, error: 'Publish post not found' });
    const result = await deps.executePublishPost(post.id, post.workspaceId, ctx.userId);
    return { success: true, data: result };
  });

  // 4. Security & Audit Center (AuditLogs, Active Sessions + Revoke, API Keys)
  app.get('/api/v1/admin/security', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const now = new Date();
    const [auditLogs, sessions, apiKeys] = await Promise.all([
      prisma.auditLog.findMany({
        include: { workspace: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 80,
      }),
      prisma.session.findMany({
        where: { expiresAt: { gt: now } },
        select: {
          id: true,
          ipAddress: true,
          userAgent: true,
          expiresAt: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true, systemRole: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.apiKey.findMany({
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
          workspace: { select: { name: true } },
          user: { select: { email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    return { success: true, data: { auditLogs, sessions, apiKeys } };
  });

  app.post('/api/v1/admin/sessions/:sessionId/revoke', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const { sessionId } = request.params as { sessionId: string };
    const deleted = await prisma.session.deleteMany({ where: { id: sessionId } });
    if (deleted.count === 0) {
      return reply.status(404).send({ success: false, error: 'Session not found' });
    }
    await deps.logAudit('ADMIN_SESSION_REVOKED', 'Session', sessionId, {}, undefined, ctx.userId);
    return { success: true };
  });

  // 5. Support Ticket Triage
  app.get('/api/v1/admin/support', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const tickets = await prisma.supportTicket.findMany({
      include: {
        workspace: { select: { name: true, planTier: true } },
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { success: true, data: tickets };
  });

  app.patch('/api/v1/admin/support/:ticketId', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const { ticketId } = request.params as { ticketId: string };
    const parsed = AdminUpdateTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: parsed.data.status },
    });
    await deps.logAudit(
      'ADMIN_SUPPORT_TICKET_UPDATED',
      'SupportTicket',
      ticketId,
      { status: parsed.data.status },
      updated.workspaceId,
      ctx.userId,
    );
    return { success: true, data: updated };
  });
}
