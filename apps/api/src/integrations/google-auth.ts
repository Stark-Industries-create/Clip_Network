import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { SAAS_PLANS } from '@clip-network/shared';
import { generateOpaqueToken, hashPassword, sha256Hex } from '../auth.js';

type Deps = {
  logAudit: (action: string, entityType: string, entityId: string, details: unknown, workspaceId?: string, userId?: string) => Promise<void>;
  trackConversion: (eventName: string, workspaceId?: string, metadata?: unknown) => Promise<void>;
  slugifyWorkspace: (name: string) => string;
  allowRequest: (key: string) => boolean;
};

const PROVIDER = 'google-login';

/**
 * Google sign-in for users (OpenID Connect, authorization code with PKCE). Uses GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET, or the YouTube OAuth client when those are unset: one Google client can serve
 * both as long as both redirect URIs are registered on it.
 */
export function getGoogleLoginConfig() {
  const clientId = (process.env['GOOGLE_CLIENT_ID'] || process.env['YOUTUBE_CLIENT_ID'])?.trim();
  const secret = (process.env['GOOGLE_CLIENT_SECRET'] || process.env['YOUTUBE_CLIENT_SECRET'])?.trim();
  if (!clientId || !secret) return null;
  try {
    const app = new URL(process.env['PUBLIC_APP_URL'] || '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname);
    if (app.username || app.password || (app.protocol !== 'https:' && !(local && app.protocol === 'http:'))) return null;
    return { clientId, secret, redirectUri: new URL('/auth/google', app.origin).href };
  } catch {
    return null;
  }
}

type GoogleProfile = { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };

async function exchange(config: NonNullable<ReturnType<typeof getGoogleLoginConfig>>, code: string, verifier: string): Promise<GoogleProfile> {
  const token = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.secret, code, code_verifier: verifier,
      grant_type: 'authorization_code', redirect_uri: config.redirectUri,
    }),
  });
  const tokens = token.ok ? await token.json() as { access_token?: string } : null;
  if (!tokens?.access_token) throw new Error('Google did not issue a token');
  const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!info.ok) throw new Error('Google profile unavailable');
  return await info.json() as GoogleProfile;
}

export function registerGoogleAuthRoutes(app: FastifyInstance, prisma: PrismaClient, deps: Deps) {
  app.get('/api/v1/auth/google/status', async () => ({ success: true, data: { enabled: Boolean(getGoogleLoginConfig()) } }));

  app.post('/api/v1/auth/google/start', async (request, reply) => {
    if (!deps.allowRequest(`google-start:${request.ip}`)) return reply.code(429).send({ success: false, error: 'Too many attempts. Wait a minute.' });
    const config = getGoogleLoginConfig();
    if (!config) return reply.code(503).send({ success: false, error: 'Google sign-in is not set up yet.' });
    const state = generateOpaqueToken();
    const verifier = generateOpaqueToken(48);
    await prisma.directSocialConnection.deleteMany({ where: { provider: PROVIDER, expiresAt: { lte: new Date() } } });
    // Signed-out attempts have no workspace or user yet; the state row alone binds the callback.
    await prisma.directSocialConnection.create({ data: {
      stateHash: sha256Hex(state), workspaceId: '', userId: '', provider: PROVIDER, verifier,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    } });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email profile',
      state, prompt: 'select_account',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return { success: true, data: { url: url.href } };
  });

  app.post('/api/v1/auth/google/complete', async (request, reply) => {
    if (!deps.allowRequest(`google-complete:${request.ip}`)) return reply.code(429).send({ success: false, error: 'Too many attempts. Wait a minute.' });
    const config = getGoogleLoginConfig();
    if (!config) return reply.code(503).send({ success: false, error: 'Google sign-in is not set up yet.' });
    const { state, code } = (request.body ?? {}) as { state?: unknown; code?: unknown };
    if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state) || typeof code !== 'string' || !code || code.length > 2048) {
      return reply.code(400).send({ success: false, error: 'Invalid Google sign-in response.' });
    }
    // Single use: the row is deleted before Google is contacted.
    const pending = await prisma.directSocialConnection.findFirst({ where: { stateHash: sha256Hex(state), provider: PROVIDER, expiresAt: { gt: new Date() } } });
    const claimed = pending ? await prisma.directSocialConnection.deleteMany({ where: { stateHash: pending.stateHash } }) : null;
    if (!pending || !claimed?.count) return reply.code(409).send({ success: false, error: 'This sign-in link expired. Try again.' });

    let profile: GoogleProfile;
    try {
      profile = await exchange(config, code, pending.verifier);
    } catch {
      return reply.code(502).send({ success: false, error: 'Google could not confirm the sign-in. Try again.' });
    }
    const email = profile.email?.trim().toLowerCase();
    if (!email || profile.email_verified !== true) {
      return reply.code(403).send({ success: false, error: 'Your Google account email is not verified.' });
    }

    const sessionToken = generateOpaqueToken(32);
    const sessionData = {
      tokenHash: sha256Hex(sessionToken), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null,
    };
    const withWorkspaces = { memberships: { include: { workspace: true }, orderBy: { createdAt: 'asc' as const } } };
    const existing = await prisma.user.findUnique({ where: { email }, include: withWorkspaces });
    if (existing) {
      if (existing.status !== 'ACTIVE') return reply.code(403).send({ success: false, error: 'This account has been suspended. Contact support.' });
      // Google has verified this address, so an unverified password account becomes verified too.
      const user = existing.emailVerifiedAt ? existing : await prisma.user.update({
        where: { id: existing.id }, data: { emailVerifiedAt: new Date(), emailVerificationToken: null }, include: withWorkspaces,
      });
      await prisma.session.create({ data: { userId: user.id, ...sessionData } });
      const workspace = user.memberships[0]?.workspace ?? null;
      await deps.logAudit('USER_LOGGED_IN', 'User', user.id, { method: 'GOOGLE' }, workspace?.id, user.id);
      return { success: true, data: { token: sessionToken, created: false, user: {
        id: user.id, email: user.email, name: user.name, systemRole: user.systemRole, emailVerified: true,
        onboardingCompleted: user.onboardingCompleted, onboardingStep: user.onboardingStep,
      }, workspace } };
    }

    const name = (profile.name?.trim() || email.split('@')[0] || 'Creator').slice(0, 100);
    const workspaceName = `${name.split(' ')[0]}'s Studio`;
    const free = SAAS_PLANS.FREE;
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: {
        // No password is set; a random hash keeps password login closed until the user sets one by reset.
        email, name, passwordHash: hashPassword(generateOpaqueToken(32)), systemRole: 'USER',
        emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), onboardingCompleted: false, onboardingStep: 1,
      } });
      const workspace = await tx.workspace.create({ data: {
        name: workspaceName, slug: deps.slugifyWorkspace(workspaceName), planTier: free.id, monthlyClipLimit: free.monthlyClipLimit,
        subscriptionStatus: 'ACTIVE', billingProviderMode: process.env['STRIPE_SECRET_KEY']?.trim() ? 'STRIPE_LIVE' : 'SANDBOX_WEBHOOK',
      } });
      await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' } });
      await tx.session.create({ data: { userId: user.id, ...sessionData } });
      return { user, workspace };
    });
    await deps.logAudit('USER_REGISTERED', 'User', result.user.id, { method: 'GOOGLE', workspaceId: result.workspace.id }, result.workspace.id, result.user.id);
    await deps.trackConversion('REGISTER_COMPLETED', result.workspace.id, { method: 'GOOGLE' });
    return reply.code(201).send({ success: true, data: { token: sessionToken, created: true, user: {
      id: result.user.id, email: result.user.email, name: result.user.name, systemRole: result.user.systemRole, emailVerified: true,
      onboardingCompleted: false, onboardingStep: 1,
    }, workspace: result.workspace } });
  });
}
