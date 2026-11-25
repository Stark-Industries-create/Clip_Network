import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { SAAS_PLANS, type PlanTier } from '@clip-network/shared';
import { encryptSecret } from '@clip-network/shared/crypto';
import { generateOpaqueToken, requireAuth, sha256Hex } from '../auth.js';

const provider = 'instagram-standalone';
const platform = 'INSTAGRAM_REELS';

function getConfig(workspaceId: string) {
  const apiKey = process.env['POSTIZ_API_KEY']?.trim();
  const app = process.env['PUBLIC_APP_URL']?.trim();
  if (process.env['POSTIZ_INSTAGRAM_WORKSPACE_ID'] !== workspaceId || !apiKey || !app) return null;
  const encryptionKey = process.env['ENCRYPTION_MASTER_KEY'];
  if ((encryptionKey || process.env['NODE_ENV'] === 'production') && !/^[a-f\d]{64}$/i.test(encryptionKey ?? '')) return null;
  try {
    const appUrl = new URL(app);
    const base = new URL(process.env['POSTIZ_API_BASE_URL'] || 'https://api.postiz.com/public/v1');
    const frontend = new URL(process.env['POSTIZ_FRONTEND_URL'] || 'https://platform.postiz.com');
    if (base.protocol !== 'https:' || frontend.protocol !== 'https:' || !['http:', 'https:'].includes(appUrl.protocol)) return null;
    return { apiKey, base: base.href.replace(/\/$/, ''), appOrigin: appUrl.origin, frontendOrigin: frontend.origin };
  } catch {
    return null;
  }
}

type Config = NonNullable<ReturnType<typeof getConfig>>;
type Integration = { id: string; name: string; identifier: string; disabled: boolean; profile: string };

async function postiz(config: Config, endpoint: string, body?: unknown) {
  const response = await fetch(`${config.base}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: config.apiKey, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Postiz request failed');
  return response.json() as Promise<unknown>;
}

async function listInstagram(config: Config) {
  const list = await postiz(config, '/integrations');
  if (!Array.isArray(list)) throw new Error('Invalid integrations response');
  return (list as Integration[]).filter((entry) => entry?.identifier === provider && typeof entry.id === 'string' && Boolean(entry.id));
}

export function registerInstagramRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post('/api/v1/social-accounts/instagram/connect', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    if (ctx.authMethod !== 'SESSION') return reply.code(403).send({ success: false, error: 'Sign in to connect Instagram.' });
    const config = getConfig(ctx.workspaceId);
    if (!config) return reply.code(503).send({ success: false, error: 'Live Instagram connection is unavailable in this workspace.' });

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } });
    const limit = SAAS_PLANS[workspace.planTier as PlanTier]?.maxSocialAccounts ?? SAAS_PLANS.FREE.maxSocialAccounts;
    const count = await prisma.socialAccount.count({ where: { workspaceId: ctx.workspaceId } });
    if (count >= limit && !await prisma.socialAccount.findFirst({
      where: { workspaceId: ctx.workspaceId, platform, integrationMode: 'SANDBOX_SIMULATED', encryptedToken: null },
      select: { id: true },
    })) return reply.code(402).send({ success: false, error: 'Your plan’s social account limit has been reached.' });

    const state = generateOpaqueToken(32);
    const stateHash = sha256Hex(state);
    const now = new Date();
    await prisma.instagramConnection.deleteMany({ where: { workspaceId: ctx.workspaceId, expiresAt: { lte: now } } });
    try {
      await prisma.instagramConnection.create({
        data: { workspaceId: ctx.workspaceId, userId: ctx.userId, stateHash, existingIdsJson: '[]', expiresAt: new Date(now.getTime() + 3_630_000) },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return reply.code(409).send({ success: false, error: 'Wait for the previous Instagram authorization link to expire before starting another.' });
      }
      throw error;
    }

    try {
      const existing = await listInstagram(config);
      const redirectUrl = new URL('/social-accounts', config.appOrigin);
      redirectUrl.searchParams.set('instagram_state', state);
      await prisma.instagramConnection.update({
        where: { stateHash }, data: { existingIdsJson: JSON.stringify(existing.map((entry) => entry.id)) },
      });
      const result = await postiz(config, '/integrations/connect', { integration: provider, redirectUrl: redirectUrl.href }) as { url: string };
      const url = new URL(result.url);
      if (url.origin !== config.frontendOrigin || url.username || url.password || !url.pathname.startsWith('/integrations/connect/')) {
        throw new Error('Invalid Postiz authorization URL');
      }
      return { success: true, data: { url: url.href } };
    } catch {
      // The provider response may have been lost after creating the link. Keep the lock until expiry.
      return reply.code(502).send({ success: false, error: 'Instagram authorization could not start. Try again after the link expires.' });
    }
  });

  app.post('/api/v1/social-accounts/instagram/complete', async (request, reply) => {
    const ctx = await requireAuth(prisma, request, reply, 'MEMBER');
    if (!ctx) return;
    if (ctx.authMethod !== 'SESSION') return reply.code(403).send({ success: false, error: 'Sign in to connect Instagram.' });
    const config = getConfig(ctx.workspaceId);
    if (!config) return reply.code(503).send({ success: false, error: 'Live Instagram connection is unavailable in this workspace.' });
    const { state } = (request.body ?? {}) as { state?: unknown };
    if (typeof state !== 'string' || !/^[\w-]{40,64}$/.test(state)) {
      return reply.code(400).send({ success: false, error: 'Invalid Instagram authorization.' });
    }
    const pending = {
      stateHash: sha256Hex(state), workspaceId: ctx.workspaceId, userId: ctx.userId, expiresAt: { gt: new Date() },
    };
    const attempt = await prisma.instagramConnection.findFirst({ where: pending });
    if (!attempt) return reply.code(409).send({ success: false, error: 'Instagram authorization expired or was already completed.' });

    let integrations: Integration[];
    try {
      integrations = await listInstagram(config);
    } catch {
      return reply.code(502).send({ success: false, error: 'Instagram confirmation is unavailable. Retry in a moment.' });
    }
    const previous = new Set(JSON.parse(attempt.existingIdsJson) as string[]);
    const added = integrations.filter((entry) => !previous.has(entry.id));
    const account = added[0];
    if (added.length !== 1 || !account || account.disabled !== false ||
      typeof account.profile !== 'string' || !/^@?[a-zA-Z0-9_.]{1,30}$/.test(account.profile)) {
      return reply.code(409).send({ success: false, error: 'Could not confirm one newly connected Instagram account. Complete authorization and retry.' });
    }
    const handle = `@${account.profile.replace(/^@/, '').toLowerCase()}`;
    const encryptedToken = encryptSecret(`${provider}:${account.id}`);
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Consume the state without reopening enrollment while the hosted link could still be valid.
        const consumed = await tx.instagramConnection.updateMany({
          where: { ...pending, expiresAt: { gt: new Date() } },
          data: { stateHash: sha256Hex(generateOpaqueToken(32)) },
        });
        if (!consumed.count) return 'expired';
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } });
        const limit = SAAS_PLANS[workspace.planTier as PlanTier]?.maxSocialAccounts ?? SAAS_PLANS.FREE.maxSocialAccounts;
        const where = { workspaceId: ctx.workspaceId, platform, accountHandle: handle };
        const existing = await tx.socialAccount.findFirst({ where });
        const data = {
          accountName: (typeof account.name === 'string' && account.name.trim().slice(0, 100)) || handle,
          encryptedToken, integrationMode: 'LIVE_OAUTH', autoPublishApproved: false,
        };
        const select = { id: true, accountHandle: true, integrationMode: true } as const;
        if (existing) {
          if (existing.integrationMode !== 'SANDBOX_SIMULATED' || existing.encryptedToken) return 'duplicate';
          return tx.socialAccount.update({ where: { id: existing.id }, data, select });
        }
        if (await tx.socialAccount.count({ where: { workspaceId: ctx.workspaceId } }) >= limit) return 'limit';
        return tx.socialAccount.create({ data: { ...where, ...data }, select });
      });
      if (result === 'limit') return reply.code(402).send({ success: false, error: 'Your social account limit has been reached.' });
      if (result === 'expired') return reply.code(409).send({ success: false, error: 'Instagram authorization expired or was already completed.' });
      if (result === 'duplicate') return reply.code(409).send({ success: false, error: 'This Instagram handle is already listed in your workspace.' });
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return reply.code(409).send({ success: false, error: 'This Instagram handle is already listed in your workspace.' });
      }
      throw error;
    }
  });
}
