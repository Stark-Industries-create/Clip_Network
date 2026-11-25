import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { SAAS_PLANS, type PlanTier } from '@clip-network/shared';
import { decryptSecret, encryptSecret } from '@clip-network/shared/crypto';
import { generateOpaqueToken, requireAuth, sha256Hex } from '../auth.js';
import { directAuthUrl, directPlatform, encodeDirectCredential, exchangeDirectCode, getDirectConfig, isDirectProvider, type DirectAccount } from './direct-social.js';

const DIRECT_PROVIDERS = ['youtube', 'tiktok', 'instagram', 'facebook', 'x'] as const;

export function registerDirectSocialRoutes(app: FastifyInstance, prisma: PrismaClient) {
  /** Which providers can be connected right now (their app credentials are configured). */
  app.get('/api/v1/social-accounts/providers', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'VIEWER');
    if (!ctx) return;
    return { success: true, data: DIRECT_PROVIDERS.map((id) => ({ id, platform: directPlatform(id), ready: Boolean(getDirectConfig(id)) })) };
  });

  app.post('/api/v1/social-accounts/direct/:provider/connect', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    const { provider } = request.params as { provider?: string };
    if (!isDirectProvider(provider)) return reply.code(404).send({ success: false, error: 'Unknown social provider.' });
    if (ctx.authMethod !== 'SESSION') return reply.code(403).send({ success: false, error: 'Sign in to connect a social account.' });
    const config = getDirectConfig(provider);
    if (!config) return reply.code(503).send({ success: false, error: 'This provider’s live connection is unavailable.' });

    const state = generateOpaqueToken();
    const verifier = generateOpaqueToken(48);
    await prisma.$transaction([
      prisma.directSocialConnection.deleteMany({ where: { workspaceId: ctx.workspaceId, userId: ctx.userId, expiresAt: { lte: new Date() } } }),
      prisma.directSocialConnection.create({ data: {
        stateHash: sha256Hex(state), workspaceId: ctx.workspaceId, userId: ctx.userId, provider,
        verifier, expiresAt: new Date(Date.now() + 10 * 60_000),
      } }),
    ]);
    return { success: true, data: { url: directAuthUrl(provider, config, state, verifier) } };
  });

  app.post('/api/v1/social-accounts/direct/complete', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    if (ctx.authMethod !== 'SESSION') return reply.code(403).send({ success: false, error: 'Sign in to connect a social account.' });
    const { state, code, accountId } = (request.body ?? {}) as Record<string, unknown>;
    if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state)) {
      return reply.code(400).send({ success: false, error: 'Invalid authorization state.' });
    }
    const pending = { stateHash: sha256Hex(state), workspaceId: ctx.workspaceId, userId: ctx.userId, expiresAt: { gt: new Date() } };
    const attempt = await prisma.directSocialConnection.findFirst({ where: pending });
    if (!attempt || !isDirectProvider(attempt.provider)) return reply.code(409).send({ success: false, error: 'Authorization expired or was already used.' });
    const provider = attempt.provider;
    const config = getDirectConfig(provider);
    if (!config) return reply.code(503).send({ success: false, error: 'This provider’s live connection is unavailable.' });
    let accounts: DirectAccount[];
    try {
      if (attempt.choices) {
        accounts = JSON.parse(decryptSecret(attempt.choices)) as DirectAccount[];
      } else {
        if (typeof code !== 'string' || !code || code.length > 2048 || !attempt.verifier) {
          return reply.code(400).send({ success: false, error: 'Missing authorization code.' });
        }
        const claim = await prisma.directSocialConnection.updateMany({
          where: { ...pending, verifier: attempt.verifier }, data: { verifier: '' },
        });
        if (!claim.count) return reply.code(409).send({ success: false, error: 'Authorization is already being completed.' });
        accounts = (await exchangeDirectCode(provider, config, code, attempt.verifier))
          .filter(({ credential, handle }) => /^[\w.-]{1,200}$/.test(credential.id) &&
            credential.id !== 'undefined' && credential.id !== 'null' && typeof handle === 'string' && Boolean(handle));
        if (!accounts.length) return reply.code(422).send({ success: false, error: 'No eligible account or Page was returned.' });
        await prisma.directSocialConnection.update({ where: { stateHash: pending.stateHash }, data: { choices: encryptSecret(JSON.stringify(accounts)) } });
      }
    } catch {
      return reply.code(502).send({ success: false, error: 'The provider could not verify this connection. Start a new authorization.' });
    }
    if (accounts.length > 1 && accountId === undefined) {
      return { success: true, data: { choices: accounts.map(({ credential, name, handle, avatarUrl }) => ({ id: credential.id, name, handle, avatarUrl: avatarUrl ?? null })) } };
    }
    const selected = accountId === undefined ? accounts[0] : accounts.find((account) => account.credential.id === accountId);
    if (!selected) return reply.code(400).send({ success: false, error: 'Choose an account returned by the provider.' });
    const platform = directPlatform(provider);
    const handle = selected.handle.slice(0, 200);
    const saved = await prisma.$transaction(async (tx) => {
      // Serialize quota checks among direct authorizations in this workspace.
      const workspace = await tx.workspace.update({ where: { id: ctx.workspaceId }, data: { updatedAt: new Date() } });
      const used = await tx.directSocialConnection.deleteMany({ where: { ...pending, expiresAt: { gt: new Date() } } });
      if (!used.count) return 'expired';
      const limit = SAAS_PLANS[workspace.planTier as PlanTier]?.maxSocialAccounts ?? SAAS_PLANS.FREE.maxSocialAccounts;
      const where = { workspaceId: ctx.workspaceId, platform, accountHandle: handle };
      const existing = await tx.socialAccount.findFirst({
        where: { workspaceId: ctx.workspaceId, platform, directAccountId: selected.credential.id },
      }) ?? await tx.socialAccount.findFirst({ where: { ...where, directAccountId: null } });
      const data = {
        accountName: (selected.name || handle).slice(0, 100), directAccountId: selected.credential.id,
        avatarUrl: selected.avatarUrl ?? null,
        integrationMode: 'LIVE_OAUTH', encryptedToken: encodeDirectCredential(selected.credential),
        autoPublishApproved: false,
      };
      const select = { id: true, accountName: true, accountHandle: true, avatarUrl: true, integrationMode: true } as const;
      if (existing) return tx.socialAccount.update({ where: { id: existing.id }, data, select });
      if (await tx.socialAccount.count({ where: { workspaceId: ctx.workspaceId } }) >= limit) return 'limit';
      return tx.socialAccount.create({ data: { ...where, ...data }, select });
    });
    if (saved === 'expired') return reply.code(409).send({ success: false, error: 'Authorization expired or was already used.' });
    if (saved === 'limit') return reply.code(402).send({ success: false, error: 'Your social account limit has been reached.' });
    return { success: true, data: saved };
  });
}
