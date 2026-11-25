import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import {
  AcceptInviteRequestSchema,
  AdminUpdateUserStatusSchema,
  BillingWebhookPayloadSchema,
  ChangePasswordRequestSchema,
  CheckoutPlanRequestSchema,
  ClipDecisionRequestSchema,
  CompleteOnboardingRequestSchema,
  CreateApiKeyRequestSchema,
  CreateCreatorRequestSchema,
  SpokenLanguageSchema,
  CreateRouteRuleRequestSchema,
  CreateSocialAccountRequestSchema,
  CreateSupportTicketRequestSchema,
  evaluateClipCompliance,
  ForgotPasswordRequestSchema,
  IngestStreamRequestSchema,
  InviteMemberRequestSchema,
  LoginRequestSchema,
  NotificationPreferencesSchema,
  RegisterRequestSchema,
  RegisterSourceVideoSchema,
  ResetPasswordRequestSchema,
  SAAS_PLANS,
  ToggleAutoPublishRequestSchema,
  UpdateMemberRoleRequestSchema,
  UpdateProfileRequestSchema,
  VerifyEmailRequestSchema,
  type PlanTier,
} from '@clip-network/shared';
import { encryptSecret } from '@clip-network/shared/crypto';
import {
  alignTranscriptToSpeechWindows,
  assToWebVtt,
  buildAutoSfxCuesForCuts,
  buildWordSyncedAss,
  SFX_PRESETS,
} from '@clip-network/clip-engine';
import {
  assertSafeExternalUrl,
  computeWebhookSignature,
  generateOpaqueToken,
  hashPassword,
  requireAuth,
  requireSuperAdmin,
  sha256Hex,
  SlidingWindowRateLimiter,
  verifyPassword,
  verifyWebhookSignature,
} from './auth.js';
import {
  cancelStripeSubscriptionIfActive,
  constructVerifiedStripeEvent,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  isStripeLiveConfigured,
  resolvePlanTierFromPriceId,
} from './integrations/stripe.js';
import { isLiveEmailConfigured, sendTransactionalEmail } from './integrations/email.js';
import { renderStoredClip } from './services/render-clip.js';
import { publishClipPost } from './services/publish-clip.js';
import { refreshStaleMetrics } from './services/post-metrics.js';
import {
  buildSourceBundlePrefix,
  buildTenantClipObjectKey,
  createPresignedS3Url,
  getS3StorageConfig,
} from './integrations/storage.js';
import { ensureCurrentBillingPeriod, getUtcBillingMonthStart } from './billing-period.js';
import { isCreatorPlatformUrl, resolveSourceConnectorWorkspace } from './integrations/source-connector.js';
import { registerDirectSocialRoutes } from './integrations/direct-social-routes.js';
import { registerInstagramRoutes } from './integrations/instagram-connect.js';
import { registerGoogleAuthRoutes } from './integrations/google-auth.js';
import { scanWorkspaceChannels } from './services/channel-monitor.js';
import { readTranscript } from './services/source-automation.js';
import { registerSuperAdminControlCenterRoutes } from './admin-routes.js';
import { refreshPlatformSettings } from './platform-settings.js';
import { registerAdminIntegrationRoutes } from './admin-integrations.js';
import { refreshCreatorProfile } from './services/channel-profile.js';
import { embedFor, fetchSourceVideoStats } from './services/video-details.js';

/** Social account fields safe to return to browsers: never the encrypted token. */
const SAFE_SOCIAL_ACCOUNT = {
  select: {
    id: true, workspaceId: true, platform: true, accountName: true, accountHandle: true, avatarUrl: true,
    integrationMode: true, autoPublishApproved: true, timezone: true, createdAt: true, updatedAt: true,
  },
} as const;

/** Fetches the channel's profile photo, waiting at most a few seconds so saving stays responsive. */
async function withChannelPhoto<T extends { id: string; platform: string; channelUrl: string; avatarUrl: string | null }>(prisma: PrismaClient, creator: T): Promise<T> {
  if (process.env['NODE_ENV'] === 'test') return creator;
  const profile = await Promise.race([
    refreshCreatorProfile(prisma, creator),
    new Promise<null>((resolve) => setTimeout(resolve, 6_000, null)),
  ]);
  return profile?.avatarUrl ? { ...creator, avatarUrl: profile.avatarUrl } : creator;
}

function slugifyWorkspace(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return `${base || 'workspace'}-${randomUUID().slice(0, 6)}`;
}

export function buildServer(prisma: PrismaClient): FastifyInstance {
  const isProd = process.env['NODE_ENV'] === 'production';
  // Behind proxies (Caddy then nginx in production) every request would otherwise appear to come
  // from the proxy, so per-IP limits like sign-in throttling would be shared by all users.
  // TRUST_PROXY_HOPS is how many proxies sit in front of the API; client X-Forwarded-For beyond them is ignored.
  const trustedHops = Number(process.env['TRUST_PROXY_HOPS'] ?? 0);
  const app = Fastify({
    ...(Number.isSafeInteger(trustedHops) && trustedHops > 0
      ? { trustProxy: (_address: string, hop: number) => hop < trustedHops } : {}),
    logger: isProd
      ? {
          level: process.env['LOG_LEVEL'] ?? 'info',
          redact: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers["x-source-connector-token"]',
            'req.headers.cookie',
            '*.password',
            '*.token',
          ],
        }
      : false,
  });

  // Never leak stack traces, Prisma internals, or secrets in HTTP 500 responses
  app.setErrorHandler((err, _request, reply) => {
    const statusCode =
      typeof (err as { statusCode?: number }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (statusCode >= 500) {
      app.log.error({ err: msg }, 'Unhandled internal server error');
      return reply.status(500).send({
        success: false,
        errorCode: 'INTERNAL_SERVER_ERROR',
        error: 'An unexpected internal error occurred. Please retry or contact support.',
      });
    }
    return reply.status(statusCode).send({
      success: false,
      errorCode: 'REQUEST_ERROR',
      error: msg || 'Bad request.',
    });
  });
  void app.register(cors, {
    origin: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'X-Workspace-Id',
      'x-billing-signature',
      'stripe-signature',
    ],
    // Lets the web player label the caption track with the creator's spoken language.
    exposedHeaders: ['X-Caption-Language'],
  });

  // Preserve exact raw bytes for Stripe webhook HMAC verification while parsing JSON normally
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as { rawBody?: Buffer }).rawBody = body;
      if (!body || body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const authRateLimiter = new SlidingWindowRateLimiter(30, 60_000);

  async function trackConversion(eventName: string, workspaceId?: string, metadata: unknown = {}) {
    await prisma.conversionEvent
      .create({
        data: {
          workspaceId: workspaceId ?? null,
          eventName,
          metadataJson: JSON.stringify(metadata),
        },
      })
      .catch(() => {});
  }

  // Pick up integration credentials a super admin saved, including from another API instance.
  app.addHook('onRequest', async () => { await refreshPlatformSettings(prisma); });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    return payload;
  });

  async function logAudit(
    action: string,
    entityType: string,
    entityId: string,
    details: unknown,
    workspaceId?: string,
    userId?: string,
  ) {
    await prisma.auditLog.create({
      data: {
        workspaceId: workspaceId ?? null,
        userId: userId ?? null,
        action,
        entityType,
        entityId,
        details: JSON.stringify(details),
      },
    });
  }

  async function executePublishPost(postId: string, workspaceId: string, userId?: string, sendTikTokDraft = false) {
    const result = await publishClipPost(prisma, postId, workspaceId, sendTikTokDraft);
    if (!result?.dispatched || !['PUBLISHED_LIVE', 'PUBLISHED_SANDBOX'].includes(result.post.status)) return result?.post ?? null;
    const { post: updated } = result;
    const post = await prisma.publishPost.findUniqueOrThrow({
      where: { id: updated.id }, include: { clipJob: true, socialAccount: true },
    });
    const { executionMode, externalPostId } = updated;
    // Seed simulated telemetry for sandbox posts.
    if (updated.status === 'PUBLISHED_SANDBOX') {
      const seed = post.id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
      const baseViews = 1200 + (seed % 4800) + post.clipJob.complianceScore * 25;
      const baseLikes = Math.round(baseViews * (0.06 + ((seed % 5) * 0.01)));
      const baseComments = Math.round(baseLikes * 0.09);
      const baseShares = Math.round(baseLikes * 0.16);
      await prisma.postMetricSnapshot.create({
        data: {
          workspaceId,
          publishPostId: updated.id,
          views: baseViews,
          likes: baseLikes,
          comments: baseComments,
          shares: baseShares,
          watchTimeAvgSec: Math.round(Math.min(post.clipJob.durationSec, 11 + (seed % 14)) * 10) / 10,
          completionRatePct: Math.min(96, 52 + (seed % 34)),
          sourceMode: 'SANDBOX_SIMULATED',
        },
      });
    }

    await logAudit(
      'PUBLISH_POST_EXECUTED',
      'PublishPost',
      updated.id,
      {
        platform: updated.platform,
        executionMode,
        externalPostId,
        accountHandle: post.socialAccount.accountHandle,
      },
      workspaceId,
      userId,
    );

    return updated;
  }

  // ============================================================================
  // 0. Health & Public Catalog
  // ============================================================================

  app.get('/api/livez', async () => ({ success: true }));
  app.get('/api/readyz', async (_request, reply) => {
    try {
      await prisma.directSocialConnection.findFirst({ select: { stateHash: true } });
      return { success: true };
    } catch {
      return reply.code(503).send({ success: false, error: 'Database or schema is unavailable.' });
    }
  });

  app.get('/api/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return {
      success: true,
      service: '@clip-network/api',
      version: '2.1.0-commercial',
      database: 'connected',
      billingMode: isStripeLiveConfigured() ? 'STRIPE_LIVE' : isProd ? 'DISABLED' : 'SANDBOX_WEBHOOK',
      publishingMode: process.env['POSTIZ_API_KEY']?.trim() ? 'LIVE_OAUTH' : 'SANDBOX_SIMULATED',
      emailMode: isLiveEmailConfigured() ? 'RESEND_LIVE' : 'SANDBOX_LOG',
      storageMode: getS3StorageConfig() ? 'S3_LIVE' : 'LOCAL_SANDBOX',
      sfxPresets: Object.values(SFX_PRESETS).map((p) => p.id),
    };
  });

  app.get('/api/v1/billing/plans', async () => ({
    success: true,
    data: Object.values(SAAS_PLANS),
  }));

  // ============================================================================
  // 1. Authentication, Registration, Email Verification, Password & Onboarding
  // ============================================================================

  app.post('/api/v1/auth/register', async (request, reply) => {
    const rate = authRateLimiter.check(`register:${request.ip}`);
    if (!rate.allowed) {
      return reply.status(429).send({
        success: false,
        errorCode: 'RATE_LIMITED',
        error: `Too many requests. Retry in ${rate.retryAfterSec}s.`,
      });
    }

    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        errorCode: 'VALIDATION_ERROR',
        error: parsed.error.flatten(),
      });
    }

    const d = parsed.data;
    const normalizedEmail = d.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return reply.status(409).send({
        success: false,
        errorCode: 'EMAIL_ALREADY_EXISTS',
        error: 'An account with this email already exists.',
      });
    }

    const verificationToken = generateOpaqueToken(24);
    const sessionToken = generateOpaqueToken(32);
    const workspaceName = d.workspaceName?.trim() || `${d.name.split(' ')[0]}'s Studio`;
    const freePlan = SAAS_PLANS.FREE;

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          name: d.name,
          passwordHash: hashPassword(d.password),
          systemRole: 'USER',
          emailVerificationToken: sha256Hex(verificationToken),
          termsAcceptedAt: new Date(),
          onboardingCompleted: false,
          onboardingStep: 1,
        },
      });

      const workspace = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug: slugifyWorkspace(workspaceName),
          planTier: freePlan.id,
          monthlyClipLimit: freePlan.monthlyClipLimit,
          subscriptionStatus: 'ACTIVE',
          billingProviderMode: process.env['STRIPE_SECRET_KEY']?.trim()
            ? 'STRIPE_LIVE'
            : 'SANDBOX_WEBHOOK',
        },
      });

      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: 'OWNER',
        },
      });

      const session = await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: sha256Hex(sessionToken),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      });

      return { user, workspace, session };
    });

    await logAudit(
      'USER_REGISTERED',
      'User',
      result.user.id,
      { email: result.user.email, workspaceId: result.workspace.id },
      result.workspace.id,
      result.user.id,
    );

    const publicAppUrl = process.env['PUBLIC_APP_URL']?.trim() || 'http://localhost:3100';
    void sendTransactionalEmail({
      to: result.user.email,
      kind: 'VERIFY_EMAIL',
      recipientName: result.user.name,
      actionUrl: `${publicAppUrl}/verify-email?token=${encodeURIComponent(verificationToken)}`,
    });
    await trackConversion('REGISTER_COMPLETED', result.workspace.id);

    return reply.status(201).send({
      success: true,
      data: {
        token: sessionToken,
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          systemRole: result.user.systemRole,
          emailVerified: false,
          onboardingCompleted: result.user.onboardingCompleted,
          onboardingStep: result.user.onboardingStep,
        },
        workspace: result.workspace,
        ...(isProd ? {} : { devVerificationToken: verificationToken }),
      },
    });
  });

  app.post('/api/v1/auth/verify-email', async (request, reply) => {
    const parsed = VerifyEmailRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const tokenHash = sha256Hex(parsed.data.token);
    const user = await prisma.user.findFirst({
      where: { emailVerificationToken: tokenHash },
    });
    if (!user) {
      return reply.status(400).send({
        success: false,
        errorCode: 'INVALID_VERIFICATION_TOKEN',
        error: 'Verification token is invalid or already used.',
      });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
      },
    });
    return { success: true, data: { emailVerified: true } };
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const rate = authRateLimiter.check(`login:${request.ip}`);
    if (!rate.allowed) {
      return reply.status(429).send({
        success: false,
        errorCode: 'RATE_LIMITED',
        error: `Too many login attempts. Retry in ${rate.retryAfterSec}s.`,
      });
    }

    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }

    const d = parsed.data;
    const user = await prisma.user.findUnique({
      where: { email: d.email.toLowerCase() },
      include: {
        memberships: {
          include: { workspace: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user || !verifyPassword(d.password, user.passwordHash)) {
      return reply.status(401).send({
        success: false,
        errorCode: 'INVALID_CREDENTIALS',
        error: 'Invalid email or password.',
      });
    }

    if (user.status !== 'ACTIVE') {
      return reply.status(403).send({
        success: false,
        errorCode: 'ACCOUNT_SUSPENDED',
        error: 'This account has been suspended. Contact support to recover access.',
      });
    }

    const sessionToken = generateOpaqueToken(32);
    const ttlMs = (d.rememberMe ? 30 : 1) * 24 * 60 * 60 * 1000;
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(sessionToken),
        expiresAt: new Date(Date.now() + ttlMs),
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    const primaryWorkspace = user.memberships[0]?.workspace ?? null;
    await logAudit(
      'USER_LOGGED_IN',
      'User',
      user.id,
      { rememberMe: d.rememberMe },
      primaryWorkspace?.id,
      user.id,
    );

    return {
      success: true,
      data: {
        token: sessionToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          systemRole: user.systemRole,
          emailVerified: Boolean(user.emailVerifiedAt),
          onboardingCompleted: user.onboardingCompleted,
          onboardingStep: user.onboardingStep,
        },
        workspace: primaryWorkspace,
      },
    };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    if (ctx.sessionId) {
      await prisma.session.deleteMany({ where: { id: ctx.sessionId } });
    }
    await logAudit('USER_LOGGED_OUT', 'User', ctx.userId, {}, ctx.workspaceId, ctx.userId);
    return { success: true };
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const workspace = await prisma.workspace.findUnique({
      where: { id: ctx.workspaceId },
    });
    const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
    if (!workspace || !user) {
      return reply.status(404).send({ success: false, error: 'Account not found' });
    }
    return {
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          systemRole: user.systemRole,
          status: user.status,
          emailVerified: Boolean(user.emailVerifiedAt),
          onboardingCompleted: user.onboardingCompleted,
          onboardingStep: user.onboardingStep,
        },
        workspace,
        workspaceRole: ctx.workspaceRole,
        plan: SAAS_PLANS[(workspace.planTier as PlanTier) ?? 'FREE'],
      },
    };
  });

  app.post('/api/v1/auth/forgot-password', async (request, reply) => {
    const parsed = ForgotPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
    });
    let devResetToken: string | undefined;
    if (user) {
      const rawToken = generateOpaqueToken(24);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: sha256Hex(rawToken),
          passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      if (!isProd) devResetToken = rawToken;
      const publicAppUrl = process.env['PUBLIC_APP_URL']?.trim() || 'http://localhost:3100';
      void sendTransactionalEmail({
        to: user.email,
        kind: 'PASSWORD_RESET',
        recipientName: user.name,
        actionUrl: `${publicAppUrl}/reset-password?token=${encodeURIComponent(rawToken)}`,
      });
    }
    return {
      success: true,
      data: {
        message: 'If that email exists, a password reset link has been dispatched.',
        ...(devResetToken ? { devResetToken } : {}),
      },
    };
  });

  app.post('/api/v1/auth/reset-password', async (request, reply) => {
    const parsed = ResetPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const tokenHash = sha256Hex(parsed.data.token);
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: { gt: new Date() },
      },
    });
    if (!user) {
      return reply.status(400).send({
        success: false,
        errorCode: 'INVALID_RESET_TOKEN',
        error: 'Reset token is invalid or expired.',
      });
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: hashPassword(parsed.data.newPassword),
          passwordResetToken: null,
          passwordResetExpiresAt: null,
        },
      }),
      prisma.session.deleteMany({ where: { userId: user.id } }),
    ]);
    return { success: true, data: { reset: true } };
  });

  app.post('/api/v1/auth/change-password', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const parsed = ChangePasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
    if (!user || !verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
      return reply.status(400).send({
        success: false,
        errorCode: 'INVALID_CURRENT_PASSWORD',
        error: 'Current password is incorrect.',
      });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(parsed.data.newPassword) },
    });
    await logAudit('PASSWORD_CHANGED', 'User', user.id, {}, ctx.workspaceId, user.id);
    return { success: true };
  });

  app.patch('/api/v1/account/profile', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const parsed = UpdateProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    if (parsed.data.name) {
      await prisma.user.update({
        where: { id: ctx.userId },
        data: { name: parsed.data.name },
      });
    }
    if (parsed.data.workspaceName && (ctx.workspaceRole === 'OWNER' || ctx.workspaceRole === 'ADMIN')) {
      await prisma.workspace.update({
        where: { id: ctx.workspaceId },
        data: { name: parsed.data.workspaceName },
      });
    }
    return { success: true };
  });

  app.post('/api/v1/onboarding/complete', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const parsed = CompleteOnboardingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const d = parsed.data;
    const [user, workspace] = await prisma.$transaction([
      prisma.user.update({
        where: { id: ctx.userId },
        data: { onboardingCompleted: true, onboardingStep: 3 },
      }),
      prisma.workspace.update({
        where: { id: ctx.workspaceId },
        data: {
          name: d.workspaceName,
          primaryPlatform: d.primaryPlatform,
        },
      }),
    ]);
    await logAudit(
      'ONBOARDING_COMPLETED',
      'Workspace',
      workspace.id,
      { workspaceName: d.workspaceName, primaryPlatform: d.primaryPlatform, requestedPlan: d.selectedPlan },
      workspace.id,
      user.id,
    );
    return {
      success: true,
      data: {
        onboardingCompleted: true,
        workspace,
        checkoutRequired: d.selectedPlan !== 'FREE' && workspace.planTier !== d.selectedPlan,
      },
    };
  });

  // ============================================================================
  // 2. Dashboard Summary (Tenant-Scoped Metrics & Health)
  // ============================================================================

  app.get('/api/v1/dashboard/summary', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;

    const [workspace, clips, creatorsCount, accountsCount, postsCount, recentAudit] =
      await Promise.all([
        prisma.workspace.findUnique({ where: { id: ctx.workspaceId } }),
        prisma.clipJob.findMany({
          where: { workspaceId: ctx.workspaceId },
          select: { executionStatus: true, approvalStatus: true, compliancePassed: true, durationMs: true },
        }),
        prisma.creatorAccount.count({ where: { workspaceId: ctx.workspaceId } }),
        prisma.socialAccount.count({ where: { workspaceId: ctx.workspaceId } }),
        prisma.publishPost.count({ where: { workspaceId: ctx.workspaceId } }),
        prisma.auditLog.findMany({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

    if (!workspace) {
      return reply.status(404).send({ success: false, error: 'Workspace not found' });
    }

    const totalExecutions = clips.length;
    const completedExecutions = clips.filter((c) => c.executionStatus === 'COMPLETED').length;
    const failedExecutions = clips.filter((c) => c.executionStatus === 'FAILED').length;
    const cancelledExecutions = clips.filter((c) => c.executionStatus === 'CANCELLED').length;
    const compliantClips = clips.filter((c) => c.compliancePassed).length;
    const remainingQuota = Math.max(0, workspace.monthlyClipLimit - workspace.clipsUsedThisPeriod);

    return {
      success: true,
      data: {
        workspace,
        plan: SAAS_PLANS[(workspace.planTier as PlanTier) ?? 'FREE'],
        metrics: {
          totalExecutions,
          completedExecutions,
          failedExecutions,
          cancelledExecutions,
          compliantClips,
          creatorsCount,
          accountsCount,
          postsCount,
          clipsUsedThisPeriod: workspace.clipsUsedThisPeriod,
          monthlyClipLimit: workspace.monthlyClipLimit,
          remainingQuota,
        },
        recentActivity: recentAudit,
      },
    };
  });

  // ============================================================================
  // 3. Tenant-Scoped Creator Accounts
  // ============================================================================

  app.get('/api/v1/creators', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const creators = await prisma.creatorAccount.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { routes: { include: { socialAccount: SAFE_SOCIAL_ACCOUNT } }, _count: { select: { clips: true, channelVideos: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      success: true,
      data: creators.map((c) => ({
        ...c,
        tags: JSON.parse(c.tagsJson) as string[],
        requiredTopics: JSON.parse(c.requiredTopicsJson) as string[],
        bannedKeywords: JSON.parse(c.bannedKeywordsJson) as string[],
      })),
    };
  });

  app.post('/api/v1/creators', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const parsed = CreateCreatorRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const workspace = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId } });
    const plan = SAAS_PLANS[(workspace?.planTier as PlanTier) ?? 'FREE'];
    const currentCount = await prisma.creatorAccount.count({ where: { workspaceId: ctx.workspaceId } });
    if (currentCount >= plan.maxCreators) {
      return reply.status(402).send({
        success: false,
        errorCode: 'PLAN_LIMIT_REACHED',
        error: `Your ${plan.name} plan allows up to ${plan.maxCreators} tagged creators. Upgrade to add more.`,
      });
    }

    const d = parsed.data;
    const urlCheck = assertSafeExternalUrl(d.channelUrl);
    if (!urlCheck.safe) {
      return reply.status(400).send({
        success: false,
        errorCode: 'SSRF_BLOCKED',
        error: urlCheck.reason,
      });
    }
    if (!isCreatorPlatformUrl(d.platform, d.channelUrl)) {
      return reply.status(400).send({ success: false, errorCode: 'CHANNEL_URL_PLATFORM', error: `Use a ${d.platform.toLowerCase()} channel URL for this creator.` });
    }
    const duplicate = await prisma.creatorAccount.findFirst({
      where: { workspaceId: ctx.workspaceId, handle: d.handle.toLowerCase() }, select: { id: true },
    });
    if (duplicate) {
      return reply.status(409).send({ success: false, errorCode: 'CREATOR_EXISTS', error: 'This creator is already tagged in your workspace.', data: duplicate });
    }
    const created = await withChannelPhoto(prisma, await prisma.creatorAccount.create({
      data: {
        workspaceId: ctx.workspaceId,
        handle: d.handle.toLowerCase(),
        displayName: d.displayName,
        platform: d.platform,
        channelUrl: d.channelUrl,
        tagsJson: JSON.stringify(d.tags),
        requiredTopicsJson: JSON.stringify(d.requiredTopics),
        bannedKeywordsJson: JSON.stringify(d.bannedKeywords),
        disallowLogos: d.disallowLogos,
        defaultLayout: d.defaultLayout,
        defaultCaptionStyle: d.defaultCaptionStyle,
        enableSfx: d.enableSfx,
        spokenLanguage: d.spokenLanguage,
        facecamCropJson: d.facecamCrop ? JSON.stringify(d.facecamCrop) : null,
      },
    }));
    await logAudit(
      'CREATOR_TAGGED',
      'CreatorAccount',
      created.id,
      { handle: created.handle, platform: created.platform, tags: d.tags },
      ctx.workspaceId,
      ctx.userId,
    );
    return reply.status(201).send({
      success: true,
      data: {
        ...created,
        tags: d.tags,
        requiredTopics: d.requiredTopics,
        bannedKeywords: d.bannedKeywords,
      },
    });
  });

  // ============================================================================
  // 4. Tenant-Scoped Linked Social Accounts (AES-256-GCM Encrypted Vault)
  // ============================================================================

  registerInstagramRoutes(app, prisma);
  registerDirectSocialRoutes(app, prisma);
  registerGoogleAuthRoutes(app, prisma, {
    logAudit, trackConversion, slugifyWorkspace,
    allowRequest: (key) => authRateLimiter.check(key).allowed,
  });

  app.get('/api/v1/social-accounts', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const accounts = await prisma.socialAccount.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { routes: { include: { creator: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      success: true,
      data: accounts.map(({ encryptedToken, ...safe }) => ({
        ...safe,
        hasEncryptedToken: Boolean(encryptedToken),
      })),
    };
  });

  app.post('/api/v1/social-accounts', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const parsed = CreateSocialAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const workspace = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId } });
    const plan = SAAS_PLANS[(workspace?.planTier as PlanTier) ?? 'FREE'];
    const currentCount = await prisma.socialAccount.count({ where: { workspaceId: ctx.workspaceId } });
    if (currentCount >= plan.maxSocialAccounts) {
      return reply.status(402).send({
        success: false,
        errorCode: 'PLAN_LIMIT_REACHED',
        error: `Your ${plan.name} plan allows up to ${plan.maxSocialAccounts} linked social accounts.`,
      });
    }

    const d = parsed.data;
    if (d.platform !== 'X' && d.accessToken) {
      return reply.status(400).send({ success: false, error: 'Use direct authorization to connect this live destination.' });
    }
    const encryptedToken = d.accessToken ? encryptSecret(d.accessToken) : null;
    const postizKey = process.env['POSTIZ_API_KEY']?.trim();
    const integrationMode =
      postizKey && postizKey.length > 8 && encryptedToken ? 'LIVE_OAUTH' : 'SANDBOX_SIMULATED';

    const created = await prisma.socialAccount.create({
      data: {
        workspaceId: ctx.workspaceId,
        platform: d.platform,
        accountName: d.accountName,
        accountHandle: d.accountHandle,
        encryptedToken,
        autoPublishApproved: d.autoPublishApproved,
        timezone: d.timezone,
        integrationMode,
      },
    });

    await logAudit(
      'SOCIAL_ACCOUNT_LINKED',
      'SocialAccount',
      created.id,
      {
        platform: created.platform,
        accountHandle: created.accountHandle,
        autoPublishApproved: created.autoPublishApproved,
        integrationMode,
      },
      ctx.workspaceId,
      ctx.userId,
    );

    const { encryptedToken: _omitted, ...safe } = created;
    return reply.status(201).send({
      success: true,
      data: { ...safe, hasEncryptedToken: Boolean(_omitted) },
    });
  });

  app.patch('/api/v1/social-accounts/:id/auto-publish', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const parsed = ToggleAutoPublishRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const existing = await prisma.socialAccount.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Social account not found' });
    }
    const updated = await prisma.socialAccount.update({
      where: { id: existing.id },
      data: { autoPublishApproved: parsed.data.autoPublishApproved },
    });
    await logAudit(
      'AUTO_PUBLISH_POLICY_UPDATED',
      'SocialAccount',
      updated.id,
      { autoPublishApproved: updated.autoPublishApproved },
      ctx.workspaceId,
      ctx.userId,
    );
    const { encryptedToken: _omitted, ...safe } = updated;
    return { success: true, data: safe };
  });

  // ============================================================================
  // 5. Tenant-Scoped Creator -> Social Account Routing Rules
  // ============================================================================

  app.get('/api/v1/routes', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const routes = await prisma.creatorRouteRule.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { creator: true, socialAccount: SAFE_SOCIAL_ACCOUNT },
      orderBy: { createdAt: 'desc' },
    });
    return {
      success: true,
      data: routes.map((r) => ({
        ...r,
        hashtags: JSON.parse(r.hashtagsJson) as string[],
      })),
    };
  });

  app.post('/api/v1/routes', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const parsed = CreateRouteRuleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const d = parsed.data;
    const [creator, account] = await Promise.all([
      prisma.creatorAccount.findFirst({ where: { id: d.creatorId, workspaceId: ctx.workspaceId } }),
      prisma.socialAccount.findFirst({ where: { id: d.socialAccountId, workspaceId: ctx.workspaceId } }),
    ]);
    if (!creator || !account) {
      return reply.status(404).send({
        success: false,
        error: 'Creator or social account not found in this workspace.',
      });
    }

    const created = await prisma.creatorRouteRule.create({
      data: {
        workspaceId: ctx.workspaceId,
        creatorId: d.creatorId,
        socialAccountId: d.socialAccountId,
        minComplianceScore: d.minComplianceScore,
        captionTemplate: d.captionTemplate,
        hashtagsJson: JSON.stringify(d.hashtags),
        enabled: d.enabled,
      },
      include: { creator: true, socialAccount: SAFE_SOCIAL_ACCOUNT },
    });
    await logAudit(
      'CREATOR_ROUTE_LINKED',
      'CreatorRouteRule',
      created.id,
      { creatorId: d.creatorId, socialAccountId: d.socialAccountId },
      ctx.workspaceId,
      ctx.userId,
    );
    return reply.status(201).send({
      success: true,
      data: { ...created, hashtags: d.hashtags },
    });
  });

  // ============================================================================
  // 6. Core Engine Integration: Stream Ingest, Execution Lifecycle, Cancel, Retry & Quota
  // ============================================================================

  app.get('/api/v1/clips', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const clips = await prisma.clipJob.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: {
        creator: true,
        sourceVideo: { select: { id: true, title: true, videoUrl: true, thumbnailUrl: true } },
        // Never send account tokens to the browser.
        publishPosts: { include: { socialAccount: SAFE_SOCIAL_ACCOUNT } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      success: true,
      data: clips.map((c) => ({
        ...c,
        sfxCues: JSON.parse(c.sfxCuesJson),
        complianceReport: JSON.parse(c.complianceReportJson),
        executionLogs: JSON.parse(c.executionLogsJson) as string[],
      })),
    };
  });

  app.post('/api/v1/clips/ingest', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const parsed = IngestStreamRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }

    // Server-side Subscription Quota Enforcement with UTC monthly rollover (402 Payment Required)
    const workspace = await ensureCurrentBillingPeriod(prisma, ctx.workspaceId);
    if (!workspace) {
      return reply.status(404).send({ success: false, error: 'Workspace not found' });
    }
    if (workspace.clipsUsedThisPeriod >= workspace.monthlyClipLimit) {
      return reply.status(402).send({
        success: false,
        errorCode: 'QUOTA_EXCEEDED',
        error: `Monthly clip quota reached (${workspace.clipsUsedThisPeriod}/${workspace.monthlyClipLimit}). Upgrade your plan to continue running the engine.`,
      });
    }

    const d = parsed.data;
    const urlCheck = assertSafeExternalUrl(d.sourceUrl);
    if (!urlCheck.safe) {
      return reply.status(400).send({
        success: false,
        errorCode: 'SSRF_BLOCKED',
        error: urlCheck.reason,
      });
    }
    const creator = await prisma.creatorAccount.findFirst({
      where: { id: d.creatorId, workspaceId: ctx.workspaceId },
      include: { routes: { where: { enabled: true }, include: { socialAccount: true } } },
    });
    if (!creator) {
      return reply.status(404).send({ success: false, error: 'Creator account not found' });
    }

    const requiresRender = process.env['NODE_ENV'] === 'production' || Boolean(getS3StorageConfig());
    if (d.endSec <= d.startSec || (requiresRender && d.endSec - d.startSec > 180)) {
      return reply.status(400).send({ success: false, error: 'Choose a positive clip duration of up to 180 seconds.' });
    }
    if (requiresRender && !d.transcriptText?.trim()) {
      return reply.status(400).send({ success: false, error: 'Provide a transcript for compliance review.' });
    }
    const startedAt = Date.now();
    const executionLogs: string[] = [
      `[${new Date().toISOString()}] QUEUED: Stream ingest accepted for @${creator.handle}`,
      `[${new Date().toISOString()}] RUNNING: Evaluating campaign compliance & disqualifier gates`,
    ];

    const durationSec = Math.max(1, Math.round((d.endSec - d.startSec) * 100) / 100);
    const transcript =
      d.transcriptText?.trim() ||
      `${creator.displayName} highlight from ${d.sourceUrl} (${d.startSec}s-${d.endSec}s).`;
    const title = d.title?.trim() || `${creator.displayName} — Viral Clip`;
    const requiredTopics = JSON.parse(creator.requiredTopicsJson) as string[];
    const bannedKeywords = JSON.parse(creator.bannedKeywordsJson) as string[];
    const tags = JSON.parse(creator.tagsJson) as string[];

    const compliance = evaluateClipCompliance({
      transcript,
      caption: title,
      requiredTopics,
      bannedKeywords,
      disallowLogos: creator.disallowLogos,
      hasAddedLogos: false,
    });
    executionLogs.push(
      `[${new Date().toISOString()}] COMPLIANCE: score=${compliance.score}/100 passed=${String(compliance.passed)}`,
    );

    const layout = d.layout ?? (creator.defaultLayout as 'SPLIT_FACECAM_BOTTOM' | 'CENTER_CROP_9_16');
    const captionStyle =
      d.captionStyle ??
      (creator.defaultCaptionStyle as
        | 'HIGH_ENERGY'
        | 'BOLD_CREATOR'
        | 'CLEAN_MINIMAL'
        | 'PODCAST_PREMIUM');
    const enableSfx = d.enableSfx ?? creator.enableSfx;

    const speechCues = alignTranscriptToSpeechWindows(transcript, [
      { startSec: 0.1, endSec: Math.min(durationSec, durationSec * 0.45) },
      { startSec: Math.min(durationSec, durationSec * 0.48), endSec: durationSec },
    ]);
    const assScript = buildWordSyncedAss(speechCues, captionStyle);
    const sfxCues = enableSfx ? buildAutoSfxCuesForCuts([durationSec * 0.45, durationSec * 0.55]) : [];

    executionLogs.push(
      `[${new Date().toISOString()}] ENGINE: Generated ${speechCues.length} voice-aligned subtitle cues & ${sfxCues.length} procedural SFX cues`,
    );

    const durationMs = Math.max(1, Date.now() - startedAt);
    executionLogs.push(requiresRender ? 'Waiting for source MP4 upload' : 'Sandbox metadata generated');

    const clipJob = await prisma.$transaction(async (tx) => {
      const reserved = await tx.workspace.updateMany({
        where: { id: ctx.workspaceId, clipsUsedThisPeriod: { lt: tx.workspace.fields.monthlyClipLimit } },
        data: { clipsUsedThisPeriod: { increment: 1 } },
      });
      if (!reserved.count) return null;
      return tx.clipJob.create({
        data: {
          workspaceId: ctx.workspaceId,
          creatorId: creator.id,
          sourceUrl: d.sourceUrl,
          title,
          startSec: d.startSec,
          endSec: d.endSec,
          durationSec,
          transcript,
          layout,
          captionStyle,
          enableSfx,
          sfxCuesJson: JSON.stringify(sfxCues),
          assScript,
          executionStatus: requiresRender ? 'PENDING' : 'COMPLETED',
          executionLogsJson: JSON.stringify(executionLogs),
          durationMs,
          compliancePassed: compliance.passed,
          complianceScore: compliance.score,
          complianceReportJson: JSON.stringify(compliance),
          approvalStatus: compliance.passed ? 'AWAITING_APPROVAL' : 'DISQUALIFIED',
        },
      });
    });
    if (!clipJob) {
      return reply.status(402).send({ success: false, errorCode: 'QUOTA_EXCEEDED', error: 'Monthly clip quota reached.' });
    }

    const routedPosts = [];
    if (compliance.passed) {
      for (const route of creator.routes) {
        if (compliance.score < route.minComplianceScore) continue;
        const routeTags = JSON.parse(route.hashtagsJson) as string[];
        const tagLine = [...tags, ...routeTags]
          .map((t) => (t.startsWith('#') ? t : `#${t.replace(/\s+/g, '')}`))
          .join(' ');
        const captionText = route.captionTemplate
          .replace('{hook}', title)
          .replace('{tags}', tagLine)
          .trim();

        const post = await prisma.publishPost.create({
          data: {
            workspaceId: ctx.workspaceId,
            clipJobId: clipJob.id,
            socialAccountId: route.socialAccountId,
            idempotencyKey: `clip-${clipJob.id}-acct-${route.socialAccountId}`,
            platform: route.socialAccount.platform,
            captionText,
            status: 'AWAITING_APPROVAL',
            executionMode: route.socialAccount.integrationMode,
          },
        });

        if (!requiresRender && route.socialAccount.autoPublishApproved) {
          const published = await executePublishPost(post.id, ctx.workspaceId, ctx.userId);
          if (published) routedPosts.push(published);
        } else {
          routedPosts.push(post);
        }
      }
    }

    await logAudit(
      'CLIP_INGESTED_AND_ROUTED',
      'ClipJob',
      clipJob.id,
      {
        creatorHandle: creator.handle,
        compliancePassed: compliance.passed,
        complianceScore: compliance.score,
        routedCount: routedPosts.length,
        durationMs,
      },
      ctx.workspaceId,
      ctx.userId,
    );

    return reply.status(201).send({
      success: true,
      data: {
        clip: {
          ...clipJob,
          sfxCues,
          complianceReport: compliance,
          executionLogs,
        },
        routedPosts,
      },
    });
  });

  app.post('/api/v1/clips/:clipId/cancel', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { clipId } = request.params as { clipId: string };
    const clip = await prisma.clipJob.findFirst({
      where: { id: clipId, workspaceId: ctx.workspaceId },
    });
    if (!clip) {
      return reply.status(404).send({ success: false, error: 'Clip not found' });
    }
    if (clip.executionStatus === 'RUNNING') {
      return reply.status(409).send({ success: false, error: 'Wait for the current render to finish.' });
    }
    const logs = JSON.parse(clip.executionLogsJson) as string[];
    logs.push(`[${new Date().toISOString()}] CANCELLED by user ${ctx.email}`);
    const updated = await prisma.$transaction(async (tx) => {
      const cancelled = await tx.clipJob.updateMany({
        where: { id: clip.id, executionStatus: { not: 'RUNNING' } },
        data: { executionStatus: 'CANCELLED', approvalStatus: 'REJECTED', executionLogsJson: JSON.stringify(logs) },
      });
      if (!cancelled.count) return null;
      await tx.publishPost.updateMany({
        where: { clipJobId: clip.id, workspaceId: ctx.workspaceId, status: { in: ['AWAITING_APPROVAL', 'FAILED'] } },
        data: { status: 'BLOCKED', errorMessage: 'Execution cancelled by user.' },
      });
      return tx.clipJob.findUniqueOrThrow({ where: { id: clip.id } });
    });
    if (!updated) return reply.status(409).send({ success: false, error: 'A render is in progress.' });
    return { success: true, data: { ...updated, executionLogs: logs } };
  });

  app.post('/api/v1/clips/:clipId/retry', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { clipId } = request.params as { clipId: string };
    const clip = await prisma.clipJob.findFirst({
      where: { id: clipId, workspaceId: ctx.workspaceId },
    });
    if (!clip) {
      return reply.status(404).send({ success: false, error: 'Clip not found' });
    }
    const storage = getS3StorageConfig();
    if (!storage) return reply.status(503).send({ success: false, error: 'Media storage is unavailable.' });
    if (clip.automationSourceKey) {
      const queued = await prisma.$transaction(async (tx) => {
        const updated = await tx.clipJob.updateMany({
          where: {
            id: clip.id, workspaceId: ctx.workspaceId, creator: { autoMonitorEnabled: true },
            OR: [
              { executionStatus: { in: ['PENDING', 'QUEUED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] } },
              { executionStatus: 'COMPLETED', outputMp4Path: null },
            ],
          },
          data: { executionStatus: 'QUEUED', errorMessage: null },
        });
        if (!updated.count) return null;
        await tx.channelVideo.updateMany({
          where: { workspaceId: ctx.workspaceId, ...(clip.sourceVideoId ? { id: clip.sourceVideoId } : { clipJobId: clip.id }) },
          data: { detectionStatus: 'PROCESSING' },
        });
        return tx.clipJob.findUniqueOrThrow({ where: { id: clip.id } });
      });
      if (!queued) return reply.status(409).send({ success: false, error: 'Clip cannot be queued in its current state.' });
      return reply.status(202).send({ success: true, data: queued });
    }
    const updated = await renderStoredClip(prisma, clip, storage);
    if (!updated) return reply.status(409).send({ success: false, error: 'Clip cannot be rendered in its current state.' });
    if (updated.executionStatus !== 'COMPLETED') {
      return reply.status(422).send({ success: false, error: updated.errorMessage ?? 'Render did not complete.' });
    }
    const automaticPosts = await prisma.publishPost.findMany({
      where: { clipJobId: clip.id, status: 'AWAITING_APPROVAL', socialAccount: { autoPublishApproved: true } },
    });
    for (const post of automaticPosts) await executePublishPost(post.id, ctx.workspaceId, ctx.userId);
    return { success: true, data: updated };
  });

  app.post('/api/v1/clips/:clipId/decision', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { clipId } = request.params as { clipId: string };
    const parsed = ClipDecisionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }

    const clip = await prisma.clipJob.findFirst({
      where: { id: clipId, workspaceId: ctx.workspaceId },
      include: { publishPosts: true },
    });
    if (!clip) {
      return reply.status(404).send({ success: false, error: 'Clip not found' });
    }
    const requiresMedia = process.env['NODE_ENV'] === 'production' || Boolean(getS3StorageConfig());
    if (parsed.data.decision === 'APPROVED' && (
      clip.executionStatus !== 'COMPLETED' || !clip.compliancePassed || (requiresMedia && !clip.outputMp4Path)
    )) {
      return reply.status(400).send({
        success: false,
        error: 'Approval requires a completed, compliant clip with playable media.',
      });
    }

    const decided = await prisma.clipJob.updateMany({
      where: { id: clip.id, executionStatus: 'COMPLETED', approvalStatus: { in: ['AWAITING_APPROVAL', 'NEEDS_REVIEW'] } },
      data: {
        approvalStatus: parsed.data.decision,
        approvedAt: parsed.data.decision === 'APPROVED' ? new Date() : null,
      },
    });

    if (!decided.count) return reply.status(409).send({ success: false, error: 'Clip is no longer awaiting review.' });
    const updatedClip = await prisma.clipJob.findUniqueOrThrow({ where: { id: clip.id } });

    const publishedPosts = [];
    if (parsed.data.decision === 'APPROVED') {
      for (const post of clip.publishPosts) {
        if (post.status === 'AWAITING_APPROVAL') {
          const pub = await executePublishPost(post.id, ctx.workspaceId, ctx.userId);
          if (pub) publishedPosts.push(pub);
        }
      }
    } else {
      await prisma.publishPost.updateMany({
        where: { clipJobId: clip.id, workspaceId: ctx.workspaceId, status: 'AWAITING_APPROVAL' },
        data: { status: 'BLOCKED', errorMessage: 'Clip rejected by human reviewer.' },
      });
    }

    return {
      success: true,
      data: { clip: updatedClip, publishedPosts },
    };
  });

  // ============================================================================
  // 7. Tenant-Scoped Publish Queue
  // ============================================================================

  app.get('/api/v1/publish-queue', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const posts = await prisma.publishPost.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { clipJob: { include: { creator: true } }, socialAccount: SAFE_SOCIAL_ACCOUNT },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: posts };
  });

  app.post('/api/v1/publish-queue/:postId/publish', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { postId } = request.params as { postId: string };
    const body = (request.body ?? {}) as { sendTikTokDraft?: boolean };
    const res = await executePublishPost(postId, ctx.workspaceId, ctx.userId, ctx.authMethod === 'SESSION' && body.sendTikTokDraft === true);
    if (!res) return reply.status(404).send({ success: false, error: 'Post not found' });
    if (!['SUBMITTED', 'PUBLISHED_LIVE', 'PUBLISHED_SANDBOX'].includes(res.status)) {
      return reply.status(409).send({ success: false, error: res.errorMessage ?? 'Post is not eligible for publishing.' });
    }
    return { success: true, data: res };
  });

  // ============================================================================
  // 8. Subscription & Billing (Server-Verified HMAC Webhooks — Never Trust Frontend)
  // ============================================================================

  app.get('/api/v1/billing/subscription', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const [workspace, invoices] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: ctx.workspaceId } }),
      prisma.subscriptionInvoice.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (!workspace) {
      return reply.status(404).send({ success: false, error: 'Workspace not found' });
    }
    return {
      success: true,
      data: {
        workspace,
        currentPlan: SAAS_PLANS[(workspace.planTier as PlanTier) ?? 'FREE'],
        plans: Object.values(SAAS_PLANS),
        invoices,
      },
    };
  });

  app.post('/api/v1/billing/checkout', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const parsed = CheckoutPlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const targetPlan = SAAS_PLANS[parsed.data.planTier];
    const hasLiveStripe = isStripeLiveConfigured();
    const publicAppUrl = process.env['PUBLIC_APP_URL']?.trim() || 'http://localhost:3100';

    if (hasLiveStripe && targetPlan.id !== 'FREE') {
      const workspace = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId } });
      if (!workspace) {
        return reply.status(404).send({ success: false, error: 'Workspace not found' });
      }
      let liveSession: Awaited<ReturnType<typeof createStripeCheckoutSession>>;
      try {
        liveSession = await createStripeCheckoutSession({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          customerEmail: ctx.email,
          existingCustomerId: workspace.stripeCustomerId,
          planTier: targetPlan.id,
          publicAppUrl,
        });
      } catch (error) {
        request.log.error({ err: error }, 'Stripe checkout failed');
        return reply.status(502).send({ success: false, error: 'Stripe could not start checkout. Try again shortly.' });
      }
      if (!liveSession) {
        return reply.status(503).send({
          success: false,
          errorCode: 'STRIPE_PRICE_NOT_CONFIGURED',
          error: 'This plan has no Stripe price yet. Ask the platform admin to finish Stripe setup.',
        });
      }
      if (!workspace.stripeCustomerId) {
        await prisma.workspace.update({
          where: { id: workspace.id },
          data: { stripeCustomerId: liveSession.customerId },
        });
      }
      await logAudit(
        'BILLING_CHECKOUT_INITIATED',
        'Workspace',
        ctx.workspaceId,
        { targetPlan: targetPlan.id, billingMode: 'STRIPE_LIVE', sessionId: liveSession.sessionId },
        ctx.workspaceId,
        ctx.userId,
      );
      return {
        success: true,
        data: {
          billingMode: 'STRIPE_LIVE',
          plan: targetPlan,
          checkoutUrl: liveSession.checkoutUrl,
          sessionId: liveSession.sessionId,
          message: 'Redirecting to Stripe Checkout.',
        },
      };
    }

    if (isProd) return reply.code(503).send({ success: false, errorCode: 'BILLING_NOT_CONFIGURED', error: 'Payments are not set up yet. The platform admin adds Stripe in Control Center, Integrations.' });

    // Build a deterministic webhook payload for sandbox testing (never mutates plan directly without signed webhook!)
    const webhookPayload = {
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      eventType: 'checkout.session.completed' as const,
      workspaceId: ctx.workspaceId,
      planTier: targetPlan.id,
      amountCents: targetPlan.priceMonthlyUsd * 100,
    };

    const rawBody = JSON.stringify(webhookPayload);
    const devSignature = !isProd && !hasLiveStripe ? computeWebhookSignature(rawBody) : undefined;

    await logAudit(
      'BILLING_CHECKOUT_INITIATED',
      'Workspace',
      ctx.workspaceId,
      { targetPlan: targetPlan.id, billingMode: 'SANDBOX_WEBHOOK' },
      ctx.workspaceId,
      ctx.userId,
    );

    return {
      success: true,
      data: {
        billingMode: 'SANDBOX_WEBHOOK',
        plan: targetPlan,
        message:
          'Sandbox billing mode active. Plan activates only after server-verified HMAC webhook confirmation.',
        ...(!isProd && !hasLiveStripe
          ? { sandboxWebhookPayload: webhookPayload, sandboxWebhookSignature: devSignature }
          : {}),
      },
    };
  });

  app.post('/api/v1/billing/portal', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const workspace = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId } });
    if (!workspace?.stripeCustomerId || !isStripeLiveConfigured()) {
      return reply.status(400).send({
        success: false,
        errorCode: 'BILLING_PORTAL_UNAVAILABLE',
        error: 'Stripe Billing Portal requires an active STRIPE_LIVE customer subscription.',
      });
    }
    const publicAppUrl = process.env['PUBLIC_APP_URL']?.trim() || 'http://localhost:3100';
    const portal = await createStripeBillingPortalSession({
      customerId: workspace.stripeCustomerId,
      publicAppUrl,
    });
    if (!portal) {
      return reply.status(503).send({ success: false, error: 'Unable to open Stripe Billing Portal.' });
    }
    return { success: true, data: portal };
  });

  app.post('/api/v1/billing/webhook/stripe', async (request, reply) => {
    const sig =
      typeof request.headers['stripe-signature'] === 'string'
        ? request.headers['stripe-signature']
        : undefined;
    const rawBody =
      (request as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));
    let event;
    try {
      event = constructVerifiedStripeEvent(rawBody, sig);
    } catch {
      return reply.status(401).send({
        success: false,
        errorCode: 'INVALID_STRIPE_SIGNATURE',
        error: 'Stripe webhook signature verification failed.',
      });
    }
    if (!event) {
      return reply.status(503).send({
        success: false,
        errorCode: 'STRIPE_NOT_CONFIGURED',
        error: 'Stripe live webhook credentials are not configured.',
      });
    }

    const existing = await prisma.subscriptionInvoice.findUnique({
      where: { externalEventId: event.id },
    });
    if (existing) return { success: true, data: { deduplicated: true } };

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const workspaceId = session.metadata?.['workspaceId'];
      const planTier = (session.metadata?.['planTier'] as PlanTier | undefined) ?? 'STARTER';
      if (workspaceId && SAAS_PLANS[planTier]) {
        const planDef = SAAS_PLANS[planTier];
        await prisma.$transaction([
          prisma.workspace.update({
            where: { id: workspaceId },
            data: {
              planTier: planDef.id,
              monthlyClipLimit: planDef.monthlyClipLimit,
              subscriptionStatus: 'ACTIVE',
              billingProviderMode: 'STRIPE_LIVE',
              ...(typeof session.customer === 'string'
                ? { stripeCustomerId: session.customer }
                : {}),
              ...(typeof session.subscription === 'string'
                ? { stripeSubscriptionId: session.subscription }
                : {}),
            },
          }),
          prisma.subscriptionInvoice.create({
            data: {
              workspaceId,
              externalEventId: event.id,
              planTier: planDef.id,
              amountCents: session.amount_total ?? planDef.priceMonthlyUsd * 100,
              status: 'PAID',
              providerMode: 'STRIPE_LIVE',
            },
          }),
        ]);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const workspaceId = sub.metadata?.['workspaceId'];
      const price = sub.items.data[0]?.price;
      const nextTier = resolvePlanTierFromPriceId(price?.id, price);
      if (workspaceId && nextTier) {
        const planDef = SAAS_PLANS[nextTier];
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: {
            planTier: planDef.id,
            monthlyClipLimit: planDef.monthlyClipLimit,
            subscriptionStatus: sub.status === 'active' ? 'ACTIVE' : 'PAST_DUE',
          },
        });
      }
    } else if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : undefined;
      if (customerId) {
        const ws = await prisma.workspace.findFirst({ where: { stripeCustomerId: customerId } });
        if (ws) {
          await prisma.$transaction([
            prisma.workspace.update({
              where: { id: ws.id },
              data: {
                subscriptionStatus: 'ACTIVE',
                clipsUsedThisPeriod: 0,
                periodResetAt: getUtcBillingMonthStart(),
              },
            }),
            prisma.subscriptionInvoice.create({
              data: {
                workspaceId: ws.id,
                externalEventId: event.id,
                planTier: ws.planTier,
                amountCents: invoice.amount_paid ?? 0,
                status: 'PAID',
                providerMode: 'STRIPE_LIVE',
              },
            }),
          ]);
        }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : undefined;
      if (customerId) {
        const ws = await prisma.workspace.findFirst({ where: { stripeCustomerId: customerId } });
        if (ws) {
          await prisma.$transaction([
            prisma.workspace.update({
              where: { id: ws.id },
              data: { subscriptionStatus: 'PAST_DUE' },
            }),
            prisma.subscriptionInvoice.create({
              data: {
                workspaceId: ws.id,
                externalEventId: event.id,
                planTier: ws.planTier,
                amountCents: invoice.amount_due ?? 0,
                status: 'FAILED',
                providerMode: 'STRIPE_LIVE',
              },
            }),
          ]);
          const owner = await prisma.workspaceMember.findFirst({
            where: { workspaceId: ws.id, role: 'OWNER' },
            include: { user: true },
          });
          if (owner?.user.email) {
            const publicAppUrl = process.env['PUBLIC_APP_URL']?.trim() || 'http://localhost:3100';
            void sendTransactionalEmail({
              to: owner.user.email,
              kind: 'PAYMENT_FAILED',
              workspaceName: ws.name,
              actionUrl: `${publicAppUrl}/settings/billing`,
            });
          }
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const workspaceId = sub.metadata?.['workspaceId'];
      if (workspaceId) {
        const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws || ws.stripeSubscriptionId !== sub.id) return { success: true };
        await prisma.$transaction([
          prisma.subscriptionInvoice.create({
            data: {
              workspaceId, externalEventId: event.id, planTier: ws.planTier,
              amountCents: 0, status: 'CANCELLED', providerMode: 'STRIPE_LIVE',
            },
          }),
          prisma.workspace.updateMany({
            where: { id: workspaceId, stripeSubscriptionId: sub.id },
            data: {
              planTier: 'FREE',
              monthlyClipLimit: SAAS_PLANS.FREE.monthlyClipLimit,
              subscriptionStatus: 'CANCELLED',
              stripeSubscriptionId: null,
            },
          }),
        ]);
        const owner = await prisma.workspaceMember.findFirst({
          where: { workspaceId: ws.id, role: 'OWNER' },
          include: { user: true },
        });
        if (owner?.user.email) {
          void sendTransactionalEmail({
            to: owner.user.email,
            kind: 'SUBSCRIPTION_CANCELLED',
            workspaceName: ws.name,
          });
        }
      }
    }

    return { success: true, data: { eventId: event.id, type: event.type } };
  });

  app.post('/api/v1/billing/webhook', async (request, reply) => {
    if (isProd) return reply.code(404).send({ success: false, error: 'Not found.' });
    const signatureHeader =
      typeof request.headers['x-billing-signature'] === 'string'
        ? request.headers['x-billing-signature']
        : undefined;

    const rawBody = JSON.stringify(request.body ?? {});
    if (!verifyWebhookSignature(rawBody, signatureHeader)) {
      return reply.status(401).send({
        success: false,
        errorCode: 'INVALID_WEBHOOK_SIGNATURE',
        error: 'Webhook signature verification failed.',
      });
    }

    const parsed = BillingWebhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }

    const evt = parsed.data;
    const workspace = await prisma.workspace.findUnique({ where: { id: evt.workspaceId } });
    if (!workspace) {
      return reply.status(404).send({ success: false, error: 'Workspace not found' });
    }

    // Idempotent webhook event handling
    const existingInvoice = await prisma.subscriptionInvoice.findUnique({
      where: { externalEventId: evt.eventId },
    });
    if (existingInvoice) {
      return { success: true, data: { deduplicated: true, workspace } };
    }

    if (evt.eventType === 'checkout.session.completed' || evt.eventType === 'invoice.paid') {
      const nextTier: PlanTier = evt.planTier ?? (workspace.planTier as PlanTier) ?? 'STARTER';
      const planDef = SAAS_PLANS[nextTier];
      const [updatedWorkspace, invoice] = await prisma.$transaction([
        prisma.workspace.update({
          where: { id: workspace.id },
          data: {
            planTier: planDef.id,
            monthlyClipLimit: planDef.monthlyClipLimit,
            subscriptionStatus: 'ACTIVE',
          },
        }),
        prisma.subscriptionInvoice.create({
          data: {
            workspaceId: workspace.id,
            externalEventId: evt.eventId,
            planTier: planDef.id,
            amountCents: evt.amountCents || planDef.priceMonthlyUsd * 100,
            status: 'PAID',
            providerMode: workspace.billingProviderMode,
          },
        }),
      ]);
      await logAudit(
        'SUBSCRIPTION_ACTIVATED',
        'Workspace',
        workspace.id,
        { planTier: planDef.id, eventId: evt.eventId, amountCents: invoice.amountCents },
        workspace.id,
      );
      return { success: true, data: { workspace: updatedWorkspace, invoice } };
    }

    if (evt.eventType === 'invoice.payment_failed') {
      const [updatedWorkspace, invoice] = await prisma.$transaction([
        prisma.workspace.update({
          where: { id: workspace.id },
          data: { subscriptionStatus: 'PAST_DUE' },
        }),
        prisma.subscriptionInvoice.create({
          data: {
            workspaceId: workspace.id,
            externalEventId: evt.eventId,
            planTier: workspace.planTier,
            amountCents: evt.amountCents,
            status: 'FAILED',
            providerMode: workspace.billingProviderMode,
          },
        }),
      ]);
      return { success: true, data: { workspace: updatedWorkspace, invoice } };
    }

    // customer.subscription.deleted
    const freePlan = SAAS_PLANS.FREE;
    const updatedWorkspace = await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        planTier: freePlan.id,
        monthlyClipLimit: freePlan.monthlyClipLimit,
        subscriptionStatus: 'CANCELLED',
      },
    });
    return { success: true, data: { workspace: updatedWorkspace } };
  });

  app.post('/api/v1/billing/cancel', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const currentWs = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId } });
    if (currentWs?.stripeSubscriptionId) {
      try {
        await cancelStripeSubscriptionIfActive(currentWs.stripeSubscriptionId);
      } catch {
        return reply.status(502).send({ success: false, error: 'Stripe cancellation could not be confirmed. Please retry.' });
      }
    }
    const freePlan = SAAS_PLANS.FREE;
    const updated = await prisma.workspace.update({
      where: { id: ctx.workspaceId },
      data: {
        planTier: freePlan.id,
        monthlyClipLimit: freePlan.monthlyClipLimit,
        subscriptionStatus: 'CANCELLED',
        stripeSubscriptionId: null,
      },
    });
    await logAudit('SUBSCRIPTION_CANCELLED', 'Workspace', ctx.workspaceId, {}, ctx.workspaceId, ctx.userId);
    return { success: true, data: updated };
  });

  app.get('/api/v1/clips/:clipId/media-url', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const { clipId } = request.params as { clipId: string };
    const clip = await prisma.clipJob.findFirst({
      where: { id: clipId, workspaceId: ctx.workspaceId },
    });
    if (!clip) return reply.status(404).send({ success: false, error: 'Clip not found' });

    const s3 = getS3StorageConfig(true);
    const objectKey = buildTenantClipObjectKey(ctx.workspaceId, clip.id, 'mp4');
    if (!s3) {
      return {
        success: true,
        data: {
          storageMode: 'LOCAL_SANDBOX',
          objectKey,
          signedUrl: null,
          message: 'S3 storage env vars are not configured; media remains in local sandbox mode.',
        },
      };
    }

    if (!clip.outputMp4Path || clip.executionStatus !== 'COMPLETED') {
      return { success: true, data: { storageMode: 'S3_LIVE', objectKey, signedUrl: null } };
    }
    const signedUrl = createPresignedS3Url({
      config: s3,
      method: 'GET',
      objectKey: clip.outputMp4Path,
      expiresSec: 900,
    });
    return {
      success: true,
      data: { storageMode: 'S3_LIVE', objectKey: clip.outputMp4Path, signedUrl, expiresSec: 900 },
    };
  });

  // The burned-in captions as a WebVTT track, for players and screen readers. Built from the clip's
  // stored ASS, which rendering replaces with the final word-timed captions, so the two always match.
  app.get('/api/v1/clips/:clipId/captions.vtt', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const { clipId } = request.params as { clipId: string };
    const clip = await prisma.clipJob.findFirst({
      where: { id: clipId, workspaceId: ctx.workspaceId },
      select: { assScript: true, executionStatus: true, creator: { select: { spokenLanguage: true } } },
    });
    if (!clip || clip.executionStatus !== 'COMPLETED') {
      return reply.status(404).send({ success: false, error: 'No captions for this clip yet.' });
    }
    const vtt = assToWebVtt(clip.assScript);
    if (vtt === 'WEBVTT\n\n') return reply.status(404).send({ success: false, error: 'This clip has no captions.' });
    const language = clip.creator.spokenLanguage === 'auto' ? undefined : clip.creator.spokenLanguage;
    return reply
      .header('Content-Type', 'text/vtt; charset=utf-8')
      .header('Cache-Control', 'private, no-store')
      .header('X-Caption-Language', language ?? 'und')
      .send(vtt);
  });

  app.post('/api/v1/clips/:clipId/upload-url', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { clipId } = request.params as { clipId: string };
    const clip = await prisma.clipJob.findFirst({
      where: { id: clipId, workspaceId: ctx.workspaceId },
    });
    if (!clip) return reply.status(404).send({ success: false, error: 'Clip not found' });

    const body = (request.body ?? {}) as { ext?: string };
    const ext = body.ext === 'png' || body.ext === 'jpg' || body.ext === 'ass' ? body.ext : 'source.mp4';
    const objectKey = buildTenantClipObjectKey(ctx.workspaceId, clip.id, ext);
    const s3 = getS3StorageConfig();
    if (!s3) {
      return {
        success: true,
        data: {
          storageMode: 'LOCAL_SANDBOX',
          objectKey,
          uploadUrl: null,
          message: 'Configure S3_* env vars to issue presigned PUT upload URLs.',
        },
      };
    }
    const uploadUrl = createPresignedS3Url({
      config: s3,
      method: 'PUT',
      objectKey,
      expiresSec: 900,
    });
    return {
      success: true,
      data: { storageMode: 'S3_LIVE', objectKey, uploadUrl, expiresSec: 900 },
    };
  });

  // ============================================================================
  // 9. API Keys & Support Tickets (Tenant-Scoped)
  // ============================================================================

  app.get('/api/v1/api-keys', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const keys = await prisma.apiKey.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: keys };
  });

  app.post('/api/v1/api-keys', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const parsed = CreateApiKeyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const workspace = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId } });
    const plan = SAAS_PLANS[(workspace?.planTier as PlanTier) ?? 'FREE'];
    const activeCount = await prisma.apiKey.count({
      where: { workspaceId: ctx.workspaceId, revokedAt: null },
    });
    if (activeCount >= plan.apiKeysAllowed) {
      return reply.status(402).send({
        success: false,
        errorCode: 'PLAN_LIMIT_REACHED',
        error: `Your ${plan.name} plan allows up to ${plan.apiKeysAllowed} active API key(s).`,
      });
    }

    const rawKey = `cn_live_${generateOpaqueToken(24)}`;
    const keyPrefix = rawKey.slice(0, 14);
    const created = await prisma.apiKey.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: parsed.data.name,
        keyPrefix,
        keyHash: sha256Hex(rawKey),
      },
    });
    await logAudit('API_KEY_CREATED', 'ApiKey', created.id, { name: created.name }, ctx.workspaceId, ctx.userId);
    return reply.status(201).send({
      success: true,
      data: {
        id: created.id,
        name: created.name,
        keyPrefix: created.keyPrefix,
        rawKey, // Shown once!
        createdAt: created.createdAt,
      },
    });
  });

  app.post('/api/v1/api-keys/:id/revoke', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const existing = await prisma.apiKey.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'API key not found' });
    }
    await prisma.apiKey.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    await logAudit('API_KEY_REVOKED', 'ApiKey', existing.id, {}, ctx.workspaceId, ctx.userId);
    return { success: true };
  });

  app.get('/api/v1/support/tickets', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const tickets = await prisma.supportTicket.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: tickets };
  });

  app.post('/api/v1/support/tickets', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const parsed = CreateSupportTicketRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const created = await prisma.supportTicket.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        subject: parsed.data.subject,
        message: parsed.data.message,
        priority: parsed.data.priority,
      },
    });
    await logAudit('SUPPORT_TICKET_OPENED', 'SupportTicket', created.id, { subject: created.subject }, ctx.workspaceId, ctx.userId);
    return reply.status(201).send({ success: true, data: created });
  });

  // ============================================================================
  // 10. Super-Admin Dashboard (SUPER_ADMIN only -> 403 for normal users)
  // ============================================================================

  app.get('/api/v1/admin/overview', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;

    const [users, workspaces, clipsCount, invoices, tickets] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          systemRole: true,
          status: true,
          emailVerifiedAt: true,
          onboardingCompleted: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.workspace.findMany({
        include: { _count: { select: { clips: true, creators: true, members: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.clipJob.count(),
      prisma.subscriptionInvoice.findMany({
        where: { status: 'PAID' },
        select: { amountCents: true },
      }),
      prisma.supportTicket.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const totalRevenueCents = invoices.reduce((acc, inv) => acc + inv.amountCents, 0);

    return {
      success: true,
      data: {
        totals: {
          users: users.length,
          workspaces: workspaces.length,
          clipsExecuted: clipsCount,
          totalRevenueUsd: Math.round(totalRevenueCents) / 100,
          openTickets: tickets.filter((t) => t.status === 'OPEN').length,
        },
        users,
        workspaces,
        tickets,
      },
    };
  });

  app.patch('/api/v1/admin/users/:userId/status', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    const parsed = AdminUpdateUserStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { status: parsed.data.status },
      select: { id: true, email: true, status: true },
    });
    if (parsed.data.status === 'SUSPENDED') {
      await prisma.session.deleteMany({ where: { userId } });
    }
    await logAudit('ADMIN_USER_STATUS_CHANGED', 'User', userId, { status: parsed.data.status }, undefined, ctx.userId);
    return { success: true, data: updated };
  });

  // ============================================================================
  // 11. Extended Resource Detail, CRUD, Live Compliance, Analytics & Members
  // ============================================================================

  app.post('/api/v1/auth/resend-verification', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    if (ctx.emailVerified) {
      return { success: true, data: { emailVerified: true, message: 'Email is already verified.' } };
    }
    const rawToken = generateOpaqueToken(24);
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { emailVerificationToken: sha256Hex(rawToken) },
    });
    return {
      success: true,
      data: {
        message: 'A new verification token has been issued.',
        ...(isProd ? {} : { devVerificationToken: rawToken }),
      },
    };
  });

  app.get('/api/v1/creators/:id', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const creator = await prisma.creatorAccount.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: {
        routes: { include: { socialAccount: SAFE_SOCIAL_ACCOUNT } },
        clips: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!creator) {
      return reply.status(404).send({ success: false, error: 'Creator not found' });
    }
    return {
      success: true,
      data: {
        ...creator,
        tags: JSON.parse(creator.tagsJson) as string[],
        requiredTopics: JSON.parse(creator.requiredTopicsJson) as string[],
        bannedKeywords: JSON.parse(creator.bannedKeywordsJson) as string[],
      },
    };
  });

  app.patch('/api/v1/creators/:id', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const existing = await prisma.creatorAccount.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Creator not found' });
    }
    const body = (request.body ?? {}) as {
      displayName?: string;
      channelUrl?: string;
      requiredTopics?: string[];
      bannedKeywords?: string[];
      disallowLogos?: boolean;
      enableSfx?: boolean;
      autoMonitorEnabled?: boolean;
      spokenLanguage?: string;
    };
    if (body.channelUrl !== undefined && (!assertSafeExternalUrl(body.channelUrl).safe || !isCreatorPlatformUrl(existing.platform, body.channelUrl))) {
      return reply.status(400).send({ success: false, errorCode: 'CHANNEL_URL_PLATFORM', error: `Use a ${existing.platform.toLowerCase()} channel URL for this creator.` });
    }
    if (body.spokenLanguage !== undefined && !SpokenLanguageSchema.safeParse(body.spokenLanguage).success) {
      return reply.status(400).send({ success: false, error: 'Use auto or a language code such as en, ne or hi.' });
    }
    const channelChanged = Boolean(body.channelUrl && body.channelUrl !== existing.channelUrl);
    let updated = await prisma.creatorAccount.update({
      where: { id: existing.id },
      data: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(channelChanged ? { channelUrl: body.channelUrl, discoveryCursor: null, sourceAccessError: null, avatarUrl: null } : {}),
        ...(body.requiredTopics ? { requiredTopicsJson: JSON.stringify(body.requiredTopics) } : {}),
        ...(body.bannedKeywords ? { bannedKeywordsJson: JSON.stringify(body.bannedKeywords) } : {}),
        ...(typeof body.disallowLogos === 'boolean' ? { disallowLogos: body.disallowLogos } : {}),
        ...(typeof body.enableSfx === 'boolean' ? { enableSfx: body.enableSfx } : {}),
        ...(typeof body.autoMonitorEnabled === 'boolean' ? { autoMonitorEnabled: body.autoMonitorEnabled } : {}),
        ...(body.spokenLanguage ? { spokenLanguage: body.spokenLanguage } : {}),
      },
    });
    if (channelChanged || !updated.avatarUrl) updated = await withChannelPhoto(prisma, updated);
    await logAudit('CREATOR_UPDATED', 'CreatorAccount', updated.id, { displayName: updated.displayName }, ctx.workspaceId, ctx.userId);
    return {
      success: true,
      data: {
        ...updated,
        tags: JSON.parse(updated.tagsJson) as string[],
        requiredTopics: JSON.parse(updated.requiredTopicsJson) as string[],
        bannedKeywords: JSON.parse(updated.bannedKeywordsJson) as string[],
      },
    };
  });

  app.delete('/api/v1/creators/:id', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const existing = await prisma.creatorAccount.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Creator not found' });
    }
    await prisma.creatorAccount.delete({ where: { id: existing.id } });
    await logAudit('CREATOR_DELETED', 'CreatorAccount', existing.id, { handle: existing.handle }, ctx.workspaceId, ctx.userId);
    return { success: true };
  });

  app.delete('/api/v1/social-accounts/:id', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const existing = await prisma.socialAccount.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Social account not found' });
    }
    await prisma.socialAccount.delete({ where: { id: existing.id } });
    await logAudit('SOCIAL_ACCOUNT_DISCONNECTED', 'SocialAccount', existing.id, { accountHandle: existing.accountHandle }, ctx.workspaceId, ctx.userId);
    return { success: true };
  });

  app.patch('/api/v1/routes/:id', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const existing = await prisma.creatorRouteRule.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Route rule not found' });
    }
    const body = (request.body ?? {}) as { enabled?: boolean; minComplianceScore?: number };
    const updated = await prisma.creatorRouteRule.update({
      where: { id: existing.id },
      data: {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.minComplianceScore === 'number' ? { minComplianceScore: body.minComplianceScore } : {}),
      },
      include: { creator: true, socialAccount: SAFE_SOCIAL_ACCOUNT },
    });
    return { success: true, data: { ...updated, hashtags: JSON.parse(updated.hashtagsJson) as string[] } };
  });

  app.delete('/api/v1/routes/:id', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { id } = request.params as { id: string };
    const existing = await prisma.creatorRouteRule.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Route rule not found' });
    }
    await prisma.creatorRouteRule.delete({ where: { id: existing.id } });
    return { success: true };
  });

  app.get('/api/v1/clips/:clipId', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const { clipId } = request.params as { clipId: string };
    const clip = await prisma.clipJob.findFirst({
      where: { id: clipId, workspaceId: ctx.workspaceId },
      include: {
        creator: true,
        sourceVideo: { select: { id: true, title: true, videoUrl: true, thumbnailUrl: true } },
        publishPosts: { include: { socialAccount: SAFE_SOCIAL_ACCOUNT }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!clip) {
      return reply.status(404).send({ success: false, error: 'Clip not found' });
    }
    return {
      success: true,
      data: {
        ...clip,
        sfxCues: JSON.parse(clip.sfxCuesJson),
        complianceReport: JSON.parse(clip.complianceReportJson),
        executionLogs: JSON.parse(clip.executionLogsJson) as string[],
      },
    };
  });

  app.post('/api/v1/compliance/evaluate', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const body = (request.body ?? {}) as {
      transcript?: string;
      caption?: string;
      requiredTopics?: string[];
      bannedKeywords?: string[];
      disallowLogos?: boolean;
      hasAddedLogos?: boolean;
    };
    const result = evaluateClipCompliance({
      transcript: body.transcript ?? '',
      caption: body.caption ?? '',
      requiredTopics: body.requiredTopics ?? [],
      bannedKeywords: body.bannedKeywords ?? [],
      disallowLogos: body.disallowLogos ?? true,
      hasAddedLogos: body.hasAddedLogos ?? false,
    });
    return { success: true, data: result };
  });

  // ============================================================================
  // 12. Automated Channel Upload Monitor -> Clip Engine -> Posting -> Insights
  // ============================================================================

  app.get('/api/v1/monitor/videos', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const { creatorId } = request.query as { creatorId?: string };
    const videos = await prisma.channelVideo.findMany({
      where: { workspaceId: ctx.workspaceId, ...(typeof creatorId === 'string' && creatorId ? { creatorId } : {}) },
      include: {
        creator: { select: { id: true, displayName: true, handle: true, platform: true, avatarUrl: true, sourceAccessError: true } },
        clips: {
          orderBy: { startSec: 'asc' },
          select: {
            id: true, executionStatus: true, approvalStatus: true, startSec: true, endSec: true, contentType: true,
            framingMode: true, qualityIssue: true, errorMessage: true,
            publishPosts: { select: { id: true, platform: true, status: true, errorMessage: true, externalPostId: true } },
          },
        },
      },
      orderBy: { detectedAt: 'desc' },
      take: creatorId ? 100 : 30,
    });
    return { success: true, data: videos };
  });

  /** One detected recording: its platform statistics, player embed, clips and how they performed. */
  app.get('/api/v1/monitor/videos/:videoId/details', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const { videoId } = request.params as { videoId: string };
    const video = await prisma.channelVideo.findFirst({
      where: { id: videoId, workspaceId: ctx.workspaceId },
      include: {
        creator: { select: { id: true, displayName: true, handle: true, platform: true, avatarUrl: true, channelUrl: true } },
        clips: {
          orderBy: { startSec: 'asc' },
          select: {
            id: true, title: true, startSec: true, endSec: true, durationSec: true, executionStatus: true, approvalStatus: true,
            qualityIssue: true, complianceScore: true,
            publishPosts: { select: { id: true, platform: true, status: true, metricSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1 } } },
          },
        },
      },
    });
    if (!video) return reply.status(404).send({ success: false, error: 'Video not found.' });
    const stats = await fetchSourceVideoStats(video.creator.platform, video.externalVideoId);
    const latest = video.clips.flatMap((clip) => clip.publishPosts.flatMap((post) => post.metricSnapshots.slice(0, 1)));
    const clipPerformance = latest.reduce((sum, snap) => ({
      views: sum.views + snap.views, likes: sum.likes + snap.likes, comments: sum.comments + snap.comments, shares: sum.shares + snap.shares,
    }), { views: 0, likes: 0, comments: 0, shares: 0 });
    let analysis: Record<string, unknown> = {};
    try { analysis = JSON.parse(video.analysisCostJson) as Record<string, unknown>; } catch { /* keep empty */ }
    return {
      success: true,
      data: {
        video: {
          id: video.id, title: video.title, videoUrl: video.videoUrl, thumbnailUrl: video.thumbnailUrl,
          externalVideoId: video.externalVideoId, detectionStatus: video.detectionStatus, automationError: video.automationError,
          publishedAt: video.publishedAt, detectedAt: video.detectedAt, durationSec: video.durationSec,
        },
        creator: video.creator,
        embed: embedFor(video.creator.platform, video.externalVideoId),
        stats,
        analysis,
        clips: video.clips.map(({ publishPosts, ...clip }) => ({ ...clip, posts: publishPosts.length })),
        clipPerformance: { ...clipPerformance, postsTracked: latest.length },
      },
    };
  });

  /** Asks the worker to analyze a recording it skipped (only the newest is clipped automatically). */
  app.post('/api/v1/monitor/videos/:videoId/clip', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { videoId } = request.params as { videoId: string };
    const queued = await prisma.channelVideo.updateMany({
      where: { id: videoId, workspaceId: ctx.workspaceId, clipJobId: null, clips: { none: {} }, detectionStatus: { in: ['SKIPPED', 'DETECTED'] } },
      data: { detectionStatus: 'DETECTED', nextAutomationAttemptAt: null, automationError: null },
    });
    if (!queued.count) return reply.status(409).send({ success: false, error: 'This video is already clipped or being processed.' });
    await logAudit('VIDEO_QUEUED_FOR_CLIPPING', 'ChannelVideo', videoId, {}, ctx.workspaceId, ctx.userId);
    return reply.status(202).send({ success: true, data: { id: videoId, detectionStatus: 'DETECTED' } });
  });

  async function requireSourceWorkspace(request: FastifyRequest, reply: FastifyReply) {
    const token = request.headers['x-source-connector-token'];
    if (token === undefined) return (await requireAuth(prisma, request, reply, 'ADMIN'))?.workspaceId ?? null;
    const workspaceId = typeof token === 'string' ? resolveSourceConnectorWorkspace(token) : null;
    if (!workspaceId) {
      void reply.status(401).send({ success: false, error: 'Invalid source connector credential.' });
    }
    return workspaceId;
  }

  app.post('/api/v1/monitor/videos', async (request, reply) => {
    const workspaceId = await requireSourceWorkspace(request, reply);
    if (!workspaceId) return;
    const parsed = RegisterSourceVideoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    const { creatorId, externalVideoId, videoUrl, title, publishedAt } = parsed.data;
    const connector = request.headers['x-source-connector-token'] !== undefined;
    const creator = await prisma.creatorAccount.findFirst({
      where: { id: creatorId, workspaceId, ...(connector ? { autoMonitorEnabled: true } : {}) },
      select: { platform: true },
    });
    if (!creator) return reply.status(404).send({ success: false, error: 'Creator not found.' });

    if (!isCreatorPlatformUrl(creator.platform, videoUrl)) {
      return reply.status(400).send({ success: false, error: 'Source URL must match the tagged creator platform.' });
    }

    const recordingStatus = parsed.data.recordingStatus ?? 'REPLAY';
    const detectionStatus = recordingStatus === 'REPLAY' ? 'DETECTED' : recordingStatus;
    const video = await prisma.$transaction(async tx => {
      const stored = await tx.channelVideo.upsert({
      where: { creatorId_externalVideoId: { creatorId, externalVideoId } },
      create: {
        workspaceId, creatorId, externalVideoId, videoUrl, title,
        publishedAt: new Date(publishedAt), durationSec: 0, detectionStatus, detectionSource: 'CREATOR_CONNECTOR',
      },
      update: { externalVideoId },
      });
      if (stored.detectionStatus !== detectionStatus && recordingStatus !== 'LIVE') {
        await tx.channelVideo.updateMany({
          where: { id: stored.id, clipJobId: null, detectionStatus: { in: recordingStatus === 'REPLAY' ? ['LIVE','FINALIZING'] : ['LIVE'] } },
          data: { detectionStatus, videoUrl, nextAutomationAttemptAt: null },
        });
        return tx.channelVideo.findUniqueOrThrow({ where: { id: stored.id } });
      }
      return stored;
    });
    return { success: true, data: video };
  });

  app.post('/api/v1/monitor/videos/:videoId/source-upload', async (request, reply) => {
    const workspaceId = await requireSourceWorkspace(request, reply);
    if (!workspaceId) return;
    const { videoId } = request.params as { videoId: string };
    const video = await prisma.channelVideo.findFirst({
      where: {
        id: videoId, workspaceId, clipJobId: null, detectionStatus: { in: ['DETECTED', 'SKIPPED'] },
        ...(request.headers['x-source-connector-token'] !== undefined ? { creator: { autoMonitorEnabled: true } } : {}),
      },
      select: { id: true, creatorId: true },
    });
    if (!video) return reply.status(404).send({ success: false, error: 'No pending source video found.' });
    const storage = getS3StorageConfig(!request.headers['x-source-connector-token']);
    if (!storage) return reply.status(503).send({ success: false, error: 'Source storage is unavailable.' });
    const prefix = buildSourceBundlePrefix(workspaceId, video.creatorId, video.id);
    return {
      success: true,
      data: {
        videoUploadUrl: createPresignedS3Url({ config: storage, method: 'PUT', objectKey: `${prefix}/source.mp4` }),
        transcriptUploadUrl: createPresignedS3Url({ config: storage, method: 'PUT', objectKey: `${prefix}/transcript.json` }),
        expiresSec: 900,
      },
    };
  });

  app.post('/api/v1/monitor/videos/:videoId/queue', async (request, reply) => {
    const workspaceId = await requireSourceWorkspace(request, reply);
    if (!workspaceId) return;
    const { videoId } = request.params as { videoId: string };
    const video = await prisma.channelVideo.findFirst({
      where: { id: videoId, workspaceId, creator: { autoMonitorEnabled: true } },
    });
    if (!video) return reply.status(404).send({ success: false, error: 'Monitored source not found.' });
    if (video.clipJobId) return { success: true, data: video };
    const storage = getS3StorageConfig();
    if (!storage) return reply.status(503).send({ success: false, error: 'Source storage is unavailable.' });

    const prefix = buildSourceBundlePrefix(workspaceId, video.creatorId, video.id);
    try {
      const transcript = await readTranscript(storage, `${prefix}/transcript.json`);
      if (!transcript?.cues.length) throw new Error('No speech cues supplied');
    } catch {
      return reply.status(422).send({ success: false, error: 'Supply a valid timed transcript and highlight range.' });
    }
    await prisma.channelVideo.updateMany({
      where: { id: video.id, workspaceId, clipJobId: null, detectionStatus: { in: ['DETECTED', 'SKIPPED'] } },
      data: { detectionStatus: 'DETECTED', nextAutomationAttemptAt: null },
    });
    return reply.status(202).send({ success: true, data: { id: video.id } });
  });

  app.post('/api/v1/monitor/scan', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const body = (request.body ?? {}) as { creatorId?: string };

    const result = await scanWorkspaceChannels({
      prisma,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      ...(body.creatorId ? { creatorId: body.creatorId } : {}),
      trackConversion,
      logAudit,
    });
    if (!result) return reply.status(404).send({ success: false, error: 'Workspace not found' });
    return { success: true, data: result };
  });

  // Dashboard refresh: only posts not checked in the last six hours are fetched from their platforms.
  // Real posts only ever show platform numbers; sandbox posts keep simulated demo data.
  app.post('/api/v1/analytics/sync-metrics', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const result = await refreshStaleMetrics(prisma, ctx.workspaceId);
    return { success: true, data: { syncedCount: result.refreshed, outcomes: result.outcomes } };
  });

  app.get('/api/v1/analytics', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const [workspace, clips, posts, creators, snapshots, detectedVideosCount] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: ctx.workspaceId } }),
      prisma.clipJob.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' } }),
      prisma.publishPost.findMany({
        where: { workspaceId: ctx.workspaceId },
        include: {
          clipJob: { include: { creator: true } },
          socialAccount: SAFE_SOCIAL_ACCOUNT,
          metricSnapshots: { orderBy: { capturedAt: 'desc' }, take: 20 },
        },
      }),
      prisma.creatorAccount.findMany({
        where: { workspaceId: ctx.workspaceId },
        include: { _count: { select: { clips: true, routes: true, channelVideos: true } } },
      }),
      prisma.postMetricSnapshot.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { capturedAt: 'asc' },
        include: { publishPost: { select: { status: true } } },
      }),
      prisma.channelVideo.count({ where: { workspaceId: ctx.workspaceId } }),
    ]);

    const totalClips = clips.length;
    const compliantCount = clips.filter((c) => c.compliancePassed).length;
    const approvedCount = clips.filter((c) => c.approvalStatus === 'APPROVED').length;
    const pendingCount = clips.filter((c) => c.approvalStatus === 'AWAITING_APPROVAL').length;
    const failedCount = clips.filter((c) => c.executionStatus === 'FAILED').length;
    const avgDurationMs =
      totalClips > 0
        ? Math.round(clips.reduce((acc, c) => acc + c.durationMs, 0) / totalClips)
        : 0;
    const publishedPosts = posts.filter((p) => p.status.startsWith('PUBLISHED'));
    const publishedCount = publishedPosts.length;
    const publishSuccessRate =
      posts.length > 0 ? Math.round((publishedCount / posts.length) * 100) : 0;

    // Latest snapshot per published post
    // A real post only counts numbers read from its platform (older builds stored simulated ones).
    const snapshotFits = (status: string, sourceMode: string) =>
      status === 'PUBLISHED_LIVE' ? sourceMode === 'LIVE_PLATFORM_API' : sourceMode === 'SANDBOX_SIMULATED';
    const latestMetrics = publishedPosts.map((p) => {
      const snap = p.metricSnapshots.find((s) => snapshotFits(p.status, s.sourceMode));
      return {
        postId: p.id,
        title: p.clipJob.title,
        creatorName: p.clipJob.creator.displayName,
        platform: p.platform,
        accountHandle: p.socialAccount.accountHandle,
        views: snap?.views ?? 0,
        likes: snap?.likes ?? 0,
        comments: snap?.comments ?? 0,
        shares: snap?.shares ?? 0,
        watchTimeAvgSec: snap?.watchTimeAvgSec ?? 0,
        completionRatePct: snap?.completionRatePct ?? 0,
        sourceMode: snap?.sourceMode ?? (p.status === 'PUBLISHED_LIVE' ? 'AWAITING_PLATFORM_METRICS' : 'SANDBOX_SIMULATED'),
        metricsCheckedAt: p.metricsCheckedAt,
        metricsError: p.metricsError,
      };
    });
    const liveCount = latestMetrics.filter((m) => m.sourceMode === 'LIVE_PLATFORM_API').length;
    const simulatedCount = latestMetrics.filter((m) => m.sourceMode === 'SANDBOX_SIMULATED').length;
    const timeline = snapshots.filter((s) => snapshotFits(s.publishPost.status, s.sourceMode));

    const totalViews = latestMetrics.reduce((s, m) => s + m.views, 0);
    const totalLikes = latestMetrics.reduce((s, m) => s + m.likes, 0);
    const totalComments = latestMetrics.reduce((s, m) => s + m.comments, 0);
    const totalShares = latestMetrics.reduce((s, m) => s + m.shares, 0);
    const avgCompletionRatePct =
      latestMetrics.length > 0
        ? Math.round(
            (latestMetrics.reduce((s, m) => s + m.completionRatePct, 0) / latestMetrics.length) * 10,
          ) / 10
        : 0;

    // Platform Breakdown for Recharts BarChart
    const platformMap = new Map<string, { platform: string; posts: number; views: number; likes: number; shares: number }>();
    for (const m of latestMetrics) {
      const cur = platformMap.get(m.platform) ?? {
        platform: m.platform,
        posts: 0,
        views: 0,
        likes: 0,
        shares: 0,
      };
      cur.posts += 1;
      cur.views += m.views;
      cur.likes += m.likes;
      cur.shares += m.shares;
      platformMap.set(m.platform, cur);
    }
    const platformBreakdown = Array.from(platformMap.values()).map((row) => ({
      ...row,
      engagementRatePct:
        row.views > 0 ? Math.round(((row.likes + row.shares) / row.views) * 1000) / 10 : 0,
    }));

    // Time-Series for Recharts AreaChart
    const timeSeries =
      timeline.length > 0
        ? timeline.slice(-12).map((s, idx) => ({
            label: `Snap ${idx + 1}`,
            views: s.views,
            likes: s.likes,
            shares: s.shares,
            completionRatePct: s.completionRatePct,
          }))
        : clips.slice(-10).map((c, idx) => ({
            label: `Clip ${idx + 1}`,
            views: 0,
            likes: 0,
            shares: 0,
            completionRatePct: c.complianceScore,
          }));

    const topPosts = [...latestMetrics].sort((a, b) => b.views - a.views).slice(0, 6);

    // Actionable Insights derived from actual workspace data
    const insights: Array<{ title: string; detail: string; category: string }> = [];
    if (platformBreakdown.length > 0) {
      const bestPlat = [...platformBreakdown].sort((a, b) => b.views - a.views)[0]!;
      insights.push({
        category: 'DISTRIBUTION',
        title: `${bestPlat.platform} leads channel reach`,
        detail: `${bestPlat.platform} generated ${bestPlat.views.toLocaleString()} views across ${bestPlat.posts} published clip(s) with a ${bestPlat.engagementRatePct}% engagement rate.`,
      });
    }
    if (topPosts.length > 0) {
      const best = topPosts[0]!;
      insights.push({
        category: 'CONTENT_HOOK',
        title: `Top performing clip: "${best.title}"`,
        detail: `Reached ${best.views.toLocaleString()} views (${best.completionRatePct}% completion) on ${best.accountHandle}. Replicate this hook & caption cadence for ${best.creatorName}.`,
      });
    }
    if (totalClips > 0) {
      const passRate = Math.round((compliantCount / totalClips) * 100);
      insights.push({
        category: 'COMPLIANCE',
        title: `Campaign compliance pass rate at ${passRate}%`,
        detail: `${compliantCount} of ${totalClips} ingested clips passed required-topic and zero-logo gates (${pendingCount} currently awaiting human approval).`,
      });
    }
    if (insights.length === 0) {
      insights.push({
        category: 'ONBOARDING',
        title: 'Run your first channel scan to unlock post insights',
        detail: 'Tag a creator channel, link a posting account, and click "Scan Channels for New Uploads" to auto-clip, publish, and collect post telemetry.',
      });
    }

    return {
      success: true,
      data: {
        scope: liveCount && simulatedCount ? 'MIXED_TELEMETRY' : liveCount ? 'LIVE_PLATFORM_METRICS' : 'SANDBOX_SIMULATED_TELEMETRY',
        disclaimer: liveCount && !simulatedCount
          ? 'Engagement is read from each platform 24 and 72 hours after publishing, and when this page is opened (at most every 6 hours).'
          : simulatedCount && !liveCount
            ? 'Pipeline counts come from workspace activity. Sandbox post engagement is simulated.'
            : 'Live posts show platform numbers; sandbox posts show simulated engagement.',
        totals: {
          detectedVideosCount,
          totalClips,
          compliantCount,
          compliancePassRate: totalClips > 0 ? Math.round((compliantCount / totalClips) * 100) : 0,
          approvedCount,
          approvalRate: totalClips > 0 ? Math.round((approvedCount / totalClips) * 100) : 0,
          pendingCount,
          failedCount,
          avgDurationMs,
          totalPosts: posts.length,
          publishedCount,
          publishSuccessRate,
          totalViews,
          totalLikes,
          totalComments,
          totalShares,
          avgCompletionRatePct,
          clipsUsedThisPeriod: workspace?.clipsUsedThisPeriod ?? 0,
          monthlyClipLimit: workspace?.monthlyClipLimit ?? 10,
        },
        timeSeries,
        platformBreakdown,
        topPosts,
        insights,
        byCreator: creators.map((c) => ({
          id: c.id,
          displayName: c.displayName,
          handle: c.handle,
          platform: c.platform,
          clipsCount: c._count.clips,
          routesCount: c._count.routes,
          detectedVideosCount: c._count.channelVideos,
        })),
      },
    };
  });

  // Automation settings and usage: recorded hours analyzed this period against the plan, and the
  // workspace's own auto-publish opt-in (each destination must also allow automatic posting).
  async function automationSettings(workspaceId: string) {
    const workspace = await ensureCurrentBillingPeriod(prisma, workspaceId);
    if (!workspace) return null;
    const plan = SAAS_PLANS[workspace.planTier as PlanTier] ?? SAAS_PLANS.FREE;
    return {
      autoPublishEnabled: workspace.autoPublishEnabled,
      autoPublishGloballyDisabled: process.env['AUTO_PUBLISH_DISABLED'] === 'true',
      analysisHoursUsed: Math.round(workspace.analysisSecondsUsed / 36) / 100,
      monthlyAnalysisHours: plan.monthlyAnalysisHours,
      maxRecordingHours: plan.maxRecordingHours,
      workerConcurrency: plan.workerConcurrency,
    };
  }

  app.get('/api/v1/workspace/automation', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const settings = await automationSettings(ctx.workspaceId);
    if (!settings) return reply.status(404).send({ success: false, error: 'Workspace not found' });
    return { success: true, data: settings };
  });

  app.patch('/api/v1/workspace/automation', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const body = (request.body ?? {}) as { autoPublishEnabled?: unknown };
    if (typeof body.autoPublishEnabled !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'Set autoPublishEnabled to true or false.' });
    }
    await prisma.workspace.update({ where: { id: ctx.workspaceId }, data: { autoPublishEnabled: body.autoPublishEnabled } });
    await logAudit('WORKSPACE_AUTO_PUBLISH_CHANGED', 'Workspace', ctx.workspaceId,
      { autoPublishEnabled: body.autoPublishEnabled }, ctx.workspaceId, ctx.userId);
    return { success: true, data: await automationSettings(ctx.workspaceId) };
  });

  app.get('/api/v1/workspace/members', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: {
        user: { select: { id: true, name: true, email: true, status: true, emailVerifiedAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      success: true,
      data: members.map((m) => ({
        id: m.id,
        role: m.role,
        joinedAt: m.createdAt,
        user: {
          ...m.user,
          emailVerified: Boolean(m.user.emailVerifiedAt),
        },
      })),
    };
  });

  app.get('/api/v1/workspace/invites', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const invites = await prisma.workspaceInvite.findMany({
      where: { workspaceId: ctx.workspaceId, acceptedAt: null },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: invites };
  });

  app.post('/api/v1/workspace/members/invite', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const parsed = InviteMemberRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const workspace = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId } });
    if (!workspace) return reply.status(404).send({ success: false, error: 'Workspace not found' });

    const normalizedEmail = parsed.data.email.toLowerCase();
    const rawToken = generateOpaqueToken(24);
    const invite = await prisma.workspaceInvite.create({
      data: {
        workspaceId: ctx.workspaceId,
        email: normalizedEmail,
        role: parsed.data.role,
        tokenHash: sha256Hex(rawToken),
        invitedById: ctx.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const publicAppUrl = process.env['PUBLIC_APP_URL']?.trim() || 'http://localhost:3100';
    void sendTransactionalEmail({
      to: normalizedEmail,
      kind: 'WORKSPACE_INVITE',
      workspaceName: workspace.name,
      actionUrl: `${publicAppUrl}/settings/team?invite=${encodeURIComponent(rawToken)}`,
    });

    await logAudit(
      'WORKSPACE_MEMBER_INVITED',
      'WorkspaceInvite',
      invite.id,
      { email: normalizedEmail, role: parsed.data.role },
      ctx.workspaceId,
      ctx.userId,
    );

    return reply.status(201).send({
      success: true,
      data: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        ...(isProd ? {} : { devInviteToken: rawToken }),
      },
    });
  });

  app.post('/api/v1/workspace/invites/accept', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const parsed = AcceptInviteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }

    const tokenHash = sha256Hex(parsed.data.token);
    const invite = await prisma.workspaceInvite.findFirst({
      where: {
        tokenHash,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!invite) {
      return reply.status(400).send({
        success: false,
        errorCode: 'INVALID_INVITE_TOKEN',
        error: 'Invitation token is invalid or expired.',
      });
    }
    if (invite.email.toLowerCase() !== ctx.email.toLowerCase()) {
      return reply.status(403).send({
        success: false,
        errorCode: 'INVITE_EMAIL_MISMATCH',
        error: 'This invitation belongs to a different email address.',
      });
    }

    const [membership] = await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: invite.workspaceId, userId: ctx.userId },
        },
        update: { role: invite.role },
        create: {
          workspaceId: invite.workspaceId,
          userId: ctx.userId,
          role: invite.role,
        },
      }),
      prisma.workspaceInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      }),
    ]);

    await logAudit(
      'WORKSPACE_INVITE_ACCEPTED',
      'WorkspaceMember',
      membership.id,
      { role: membership.role },
      invite.workspaceId,
      ctx.userId,
    );

    return { success: true, data: membership };
  });

  app.patch('/api/v1/workspace/members/:memberId/role', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'OWNER');
    if (!ctx) return;
    const { memberId } = request.params as { memberId: string };
    const parsed = UpdateMemberRoleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    const existing = await prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId: ctx.workspaceId },
    });
    if (!existing) return reply.status(404).send({ success: false, error: 'Member not found' });
    if (existing.role === 'OWNER') {
      return reply.status(400).send({ success: false, error: 'Cannot modify OWNER role directly.' });
    }
    const updated = await prisma.workspaceMember.update({
      where: { id: existing.id },
      data: { role: parsed.data.role },
    });
    await logAudit(
      'WORKSPACE_MEMBER_ROLE_UPDATED',
      'WorkspaceMember',
      updated.id,
      { role: updated.role },
      ctx.workspaceId,
      ctx.userId,
    );
    return { success: true, data: updated };
  });

  app.delete('/api/v1/workspace/members/:memberId', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'ADMIN');
    if (!ctx) return;
    const { memberId } = request.params as { memberId: string };
    const existing = await prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId: ctx.workspaceId },
    });
    if (!existing) return reply.status(404).send({ success: false, error: 'Member not found' });
    if (existing.role === 'OWNER') {
      return reply.status(400).send({ success: false, error: 'Cannot remove workspace OWNER.' });
    }
    await prisma.workspaceMember.delete({ where: { id: existing.id } });
    await logAudit(
      'WORKSPACE_MEMBER_REMOVED',
      'WorkspaceMember',
      existing.id,
      { removedUserId: existing.userId },
      ctx.workspaceId,
      ctx.userId,
    );
    return { success: true };
  });

  app.get('/api/v1/account/notifications', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
    const parsed = NotificationPreferencesSchema.safeParse(
      user?.notificationPrefsJson ? JSON.parse(user.notificationPrefsJson) : {},
    );
    return {
      success: true,
      data: parsed.success
        ? parsed.data
        : { approvals: true, failures: true, billing: true, security: true },
    };
  });

  app.patch('/api/v1/account/notifications', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    const parsed = NotificationPreferencesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.flatten() });
    }
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { notificationPrefsJson: JSON.stringify(parsed.data) },
    });
    return { success: true, data: parsed.data };
  });

  app.get('/api/v1/admin/funnel', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const events = await prisma.conversionEvent.groupBy({
      by: ['eventName'],
      _count: { eventName: true },
    });
    return {
      success: true,
      data: events.map((e) => ({ eventName: e.eventName, count: e._count.eventName })),
    };
  });

  registerSuperAdminControlCenterRoutes(app, prisma, {
    logAudit,
    executePublishPost,
  });
  registerAdminIntegrationRoutes(app, prisma, logAudit);

  return app;
}
