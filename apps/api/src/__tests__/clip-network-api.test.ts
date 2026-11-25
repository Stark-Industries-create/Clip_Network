import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildServer } from '../server.js';
import { computeWebhookSignature } from '../auth.js';
import { encryptSecret } from '@clip-network/shared/crypto';
import { syncSourceConnectorSubscriptions } from '../integrations/source-connector.js';
import { getS3StorageConfig } from '../integrations/storage.js';
import { processWorkspaceSources, selectHighlight } from '../services/source-automation.js';
import { scanWorkspaceChannels } from '../services/channel-monitor.js';
import { reconcileSubmittedPosts } from '../services/publish-clip.js';
import * as renderService from '../services/render-clip.js';

const TEST_DB_PATH = join(process.cwd(), 'data', 'test-saas-e2e.db');
const TEST_DB_URL = `file:${TEST_DB_PATH.replace(/\\/g, '/')}`;

describe('Clip Network Commercial SaaS — End-to-End Integration Suite', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;

  let tenantAToken = '';
  let tenantAWorkspaceId = '';
  let tenantAUserId = '';
  let tenantAVerificationToken = '';
  let tenantBToken = '';
  let adminToken = '';

  let creatorId = '';
  let manualAccountId = '';
  let autoAccountId = '';
  let compliantClipId = '';
  let apiKeyId = '';
  let rawApiKey = '';

  beforeAll(async () => {
    try {
      rmSync(TEST_DB_PATH, { force: true });
    } catch {
      // ignore if missing
    }
    process.env['DATABASE_URL'] = TEST_DB_URL;
    process.env['SUPER_ADMIN_EMAIL'] = 'admin@clipnetwork.io';
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    const schemaPath = new URL('../../prisma/schema.prisma', import.meta.url);
    const schemaSql = execFileSync(process.execPath, [
      prismaCli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', fileURLToPath(schemaPath), '--script',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    });
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
    const database = new DatabaseSync(TEST_DB_PATH);
    try {
      database.exec(schemaSql);
    } finally {
      database.close();
    }

    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    app = buildServer(prisma);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    try {
      rmSync(TEST_DB_PATH, { force: true });
    } catch {
      // ignore
    }
  });

  it('1. Public health & 4-tier pricing catalog work without auth', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().database).toBe('connected');

    const plans = await app.inject({ method: 'GET', url: '/api/v1/billing/plans' });
    expect(plans.statusCode).toBe(200);
    expect(plans.json().data.length).toBe(4);
  });

  it('reports liveness separately from database and migration readiness', async () => {
    expect((await app.inject({ url: '/api/livez' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/readyz' })).statusCode).toBe(200);
    const unavailableDb = new PrismaClient({ datasources: { db: { url: 'file::memory:' } } });
    const unavailableApp = buildServer(unavailableDb);
    try {
      expect((await unavailableApp.inject({ url: '/api/livez' })).statusCode).toBe(200);
      expect((await unavailableApp.inject({ url: '/api/readyz' })).statusCode).toBe(503);
    } finally {
      await unavailableApp.close();
      await unavailableDb.$disconnect();
    }
  });

  it('2. Blocks unauthenticated access to protected SaaS routes (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/creators' });
    expect(res.statusCode).toBe(401);
    expect(res.json().errorCode).toBe('UNAUTHORIZED');
  });

  it('3. Registers Tenant A, enforces duplicate email (409) & verifies email', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Alex Founder',
        email: 'alex@studio-a.io',
        password: 'Password123',
        workspaceName: 'Studio A Network',
        termsAccepted: true,
      },
    });
    expect(reg.statusCode).toBe(201);
    const body = reg.json().data;
    tenantAToken = body.token;
    tenantAWorkspaceId = body.workspace.id;
    tenantAUserId = body.user.id;
    tenantAVerificationToken = body.devVerificationToken;
    expect(body.user.emailVerified).toBe(false);
    expect(body.workspace.planTier).toBe('FREE');

    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Duplicate',
        email: 'alex@studio-a.io',
        password: 'Password123',
        termsAccepted: true,
      },
    });
    expect(dup.statusCode).toBe(409);

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: tenantAVerificationToken },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.emailVerified).toBe(true);
  });

  it('4. Completes onboarding and persists workspace setup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/onboarding/complete',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        workspaceName: 'Studio A Pro Clips',
        primaryPlatform: 'TWITCH',
        selectedPlan: 'FREE',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.onboardingCompleted).toBe(true);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.onboardingCompleted).toBe(true);
    expect(me.json().data.workspace.name).toBe('Studio A Pro Clips');
  });

  it('5. Creates & authenticates with X-Api-Key, then revokes it cleanly', async () => {
    const createKey = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: { name: 'CI Automation Key' },
    });
    expect(createKey.statusCode).toBe(201);
    apiKeyId = createKey.json().data.id;
    rawApiKey = createKey.json().data.rawKey;
    expect(rawApiKey.startsWith('cn_live_')).toBe(true);

    const viaKey = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: { 'x-api-key': rawApiKey },
    });
    expect(viaKey.statusCode).toBe(200);

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/api-keys/${apiKeyId}/revoke`,
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: { 'x-api-key': rawApiKey },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('6. Core Engine: tags creator, links accounts, ingests clip with lifecycle logs, enforces compliance & approval gate', async () => {
    const creator = await app.inject({
      method: 'POST',
      url: '/api/v1/creators',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        handle: 'lacy',
        displayName: 'Lacy',
        platform: 'TWITCH',
        channelUrl: 'https://www.twitch.tv/lacy',
        tags: ['GTA6', 'Lacy'],
        requiredTopics: ['GTA', 'marathon'],
        bannedKeywords: ['gambling'],
        disallowLogos: true,
        defaultLayout: 'SPLIT_FACECAM_BOTTOM',
        defaultCaptionStyle: 'HIGH_ENERGY',
        enableSfx: true,
      },
    });
    expect(creator.statusCode).toBe(201);
    creatorId = creator.json().data.id;

    const manual = await app.inject({
      method: 'POST',
      url: '/api/v1/social-accounts',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        platform: 'INSTAGRAM_REELS',
        accountName: 'Lacy Manual',
        accountHandle: '@lacy.manual',
        autoPublishApproved: false,
      },
    });
    expect(manual.statusCode).toBe(201);
    manualAccountId = manual.json().data.id;

    const auto = await app.inject({
      method: 'POST',
      url: '/api/v1/social-accounts',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        platform: 'TIKTOK',
        accountName: 'Lacy Auto',
        accountHandle: '@lacy.auto',
        autoPublishApproved: true,
      },
    });
    expect(auto.statusCode).toBe(201);
    autoAccountId = auto.json().data.id;

    for (const socialAccountId of [manualAccountId, autoAccountId]) {
      const route = await app.inject({
        method: 'POST',
        url: '/api/v1/routes',
        headers: { authorization: `Bearer ${tenantAToken}` },
        payload: { creatorId, socialAccountId, minComplianceScore: 75, hashtags: ['GTA6'] },
      });
      expect(route.statusCode).toBe(201);
    }

    const ingest = await app.inject({
      method: 'POST',
      url: '/api/v1/clips/ingest',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        creatorId,
        sourceUrl: 'https://www.twitch.tv/videos/2933767012',
        title: 'Lacy GTA 6 Marathon Hype',
        startSec: 120,
        endSec: 142,
        transcriptText: 'We are doing a crazy GTA 6 marathon tonight on stream!',
      },
    });
    expect(ingest.statusCode).toBe(201);
    const data = ingest.json().data;
    compliantClipId = data.clip.id;
    expect(data.clip.executionStatus).toBe('COMPLETED');
    expect(data.clip.executionLogs.length).toBeGreaterThanOrEqual(4);
    expect(data.clip.compliancePassed).toBe(true);
    expect(data.routedPosts.length).toBe(2);

    const manualPost = data.routedPosts.find((p: { socialAccountId: string }) => p.socialAccountId === manualAccountId);
    const autoPost = data.routedPosts.find((p: { socialAccountId: string }) => p.socialAccountId === autoAccountId);
    expect(manualPost.status).toBe('AWAITING_APPROVAL');
    expect(autoPost.status).toBe('PUBLISHED_SANDBOX');

    const publishManual = () => app.inject({
      method: 'POST',
      url: `/api/v1/publish-queue/${manualPost.id}/publish`,
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect((await publishManual()).statusCode).toBe(409);

    // Cancel & Retry lifecycle test
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/clips/${compliantClipId}/cancel`,
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.executionStatus).toBe('CANCELLED');

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/clips/${compliantClipId}/retry`,
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(retry.statusCode).toBe(503);
    expect((await publishManual()).statusCode).toBe(409);
  });

  it('7. Enforces strict multi-tenant isolation between Tenant A and Tenant B', async () => {
    const regB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Beta User',
        email: 'beta@studio-b.io',
        password: 'Password123',
        workspaceName: 'Studio B',
        termsAccepted: true,
      },
    });
    expect(regB.statusCode).toBe(201);
    tenantBToken = regB.json().data.token;

    // Tenant B must see 0 creators & 0 clips
    const creatorsB = await app.inject({
      method: 'GET',
      url: '/api/v1/creators',
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    expect(creatorsB.statusCode).toBe(200);
    expect(creatorsB.json().data.length).toBe(0);

    // Tenant B cannot approve or cancel Tenant A's clip (404)
    const crossDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/clips/${compliantClipId}/decision`,
      headers: { authorization: `Bearer ${tenantBToken}` },
      payload: { decision: 'APPROVED' },
    });
    expect(crossDecision.statusCode).toBe(404);
  });

  it('connects Instagram only after a signed-in user returns and Postiz confirms the new account', async () => {
    const headers = { authorization: `Bearer ${tenantBToken}` };
    const me = await app.inject({ url: '/api/v1/auth/me', headers });
    const workspaceId = me.json().data.workspace.id;
    const sandbox = await prisma.socialAccount.create({
      data: { workspaceId, platform: 'INSTAGRAM_REELS', accountName: 'Sandbox', accountHandle: '@confirmed.creator', autoPublishApproved: true },
    });
    vi.stubEnv('POSTIZ_INSTAGRAM_WORKSPACE_ID', workspaceId);
    vi.stubEnv('POSTIZ_API_KEY', 'mock-postiz-token');
    vi.stubEnv('POSTIZ_API_BASE_URL', 'https://api.postiz.com/public/v1');
    vi.stubEnv('POSTIZ_FRONTEND_URL', 'https://platform.postiz.com');
    vi.stubEnv('PUBLIC_APP_URL', 'https://clip.example.test');
    let returnedState = '';
    let confirmed = false;
    const existing = { id: 'previous', identifier: 'instagram-standalone', profile: 'previous', disabled: false };
    const remote = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/integrations/connect')) {
        const body = JSON.parse(String(init?.body));
        expect(body.integration).toBe('instagram-standalone');
        const redirect = new URL(body.redirectUrl);
        expect(redirect.origin).toBe('https://clip.example.test');
        returnedState = redirect.searchParams.get('instagram_state') ?? '';
        return Response.json({ url: 'https://platform.postiz.com/integrations/connect/fixture' });
      }
      return Response.json(confirmed ? [existing, {
        id: 'confirmed-fixture', identifier: 'instagram-standalone', profile: 'Confirmed.Creator',
        disabled: false, name: 'Confirmed Creator',
      }] : [existing]);
    });
    const call = (action: string, token = tenantBToken, payload?: object) => app.inject({
      method: 'POST', url: `/api/v1/social-accounts/instagram/${action}`,
      headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}),
    });
    try {
      expect((await call('connect', tenantAToken)).statusCode).toBe(503);
      expect((await call('connect')).json().data.url).toContain('platform.postiz.com');
      expect(returnedState.length).toBeGreaterThan(40);
      expect((await call('connect')).statusCode).toBe(409);
      expect((await call('complete', tenantBToken, { state: returnedState, added: 'instagram-standalone' })).statusCode).toBe(409);
      expect((await call('complete', tenantBToken, { state: 'x'.repeat(43) })).statusCode).toBe(409);
      confirmed = true;
      const complete = await call('complete', tenantBToken, { state: returnedState });
      expect(complete.statusCode).toBe(200);
      expect(complete.json().data.accountHandle).toBe('@confirmed.creator');
      expect(complete.json().data.id).toBe(sandbox.id);
      expect(complete.json().data.encryptedToken).toBeUndefined();
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: complete.json().data.id } })).autoPublishApproved).toBe(false);
      expect((await call('complete', tenantBToken, { state: returnedState })).statusCode).toBe(409);
    } finally {
      remote.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('connects a selected Facebook Page directly and binds OAuth state to the initiating workspace', async () => {
    vi.stubEnv('FACEBOOK_CLIENT_ID', 'client-fixture');
    vi.stubEnv('FACEBOOK_CLIENT_SECRET', 'secret-fixture');
    vi.stubEnv('ENCRYPTION_MASTER_KEY', 'a'.repeat(64));
    vi.stubEnv('PUBLIC_APP_URL', 'https://clip.example.test');
    const remote = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('graph.facebook.com');
      if (url.pathname.endsWith('/oauth/access_token')) return Response.json({ access_token: 'mock-user-token' });
      expect(url.pathname).toMatch(/\/me\/accounts$/);
      return Response.json({ data: [
        { id: '111', name: 'First Page', access_token: 'first-private-token', tasks: ['CREATE_CONTENT'] },
        { id: '222', name: 'Second Page', access_token: 'second-private-token', tasks: ['CREATE_CONTENT'] },
      ] });
    });
    const call = (route: string, token: string, payload?: object) => app.inject({
      method: 'POST', url: `/api/v1/social-accounts/direct/${route}`,
      headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}),
    });
    try {
      const start = await call('facebook/connect', tenantBToken);
      expect(start.statusCode).toBe(200);
      const url = new URL(start.json().data.url);
      expect(url.hostname).toBe('www.facebook.com');
      expect(url.searchParams.get('redirect_uri')).toBe('https://clip.example.test/social-accounts');
      const state = url.searchParams.get('state');
      expect((await call('complete', tenantAToken, { state, code: 'fixture-code' })).statusCode).toBe(409);
      const linked = await call('complete', tenantBToken, { state, code: 'fixture-code' });
      expect(linked.json().data.choices.map((row: { id: string }) => row.id)).toEqual(['111', '222']);
      expect(linked.body).not.toContain('private-token');
      expect((await call('complete', tenantBToken, { state, accountId: '333' })).statusCode).toBe(400);
      const saved = await call('complete', tenantBToken, { state, accountId: '222' });
      expect(saved.statusCode).toBe(200);
      const record = await prisma.socialAccount.findUniqueOrThrow({ where: { id: saved.json().data.id } });
      expect(record.directAccountId).toBe('222');
      expect(record.platform).toBe('FACEBOOK_REELS');
      expect(record.autoPublishApproved).toBe(false);
      expect(saved.body).not.toContain('private-token');
      expect((await call('complete', tenantBToken, { state, accountId: '222' })).statusCode).toBe(409);
    } finally {
      remote.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('8. Enforces server-side monthly clip quota (402) and upgrades via HMAC-signed billing webhook', async () => {
    // Set Tenant A usage to limit (10/10)
    await prisma.workspace.update({
      where: { id: tenantAWorkspaceId },
      data: { clipsUsedThisPeriod: 10 },
    });

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/clips/ingest',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        creatorId,
        sourceUrl: 'https://www.twitch.tv/videos/2933767012',
        title: 'Over Quota Clip',
        startSec: 10,
        endSec: 25,
        transcriptText: 'GTA marathon clip over quota',
      },
    });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().errorCode).toBe('QUOTA_EXCEEDED');

    // Unsigned webhook must be rejected (401)
    const webhookPayload = {
      eventId: 'evt_pro_upgrade_001',
      eventType: 'checkout.session.completed',
      workspaceId: tenantAWorkspaceId,
      planTier: 'PRO',
      amountCents: 9900,
    };
    const badSig = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'x-billing-signature': 'invalid-signature' },
      payload: webhookPayload,
    });
    expect(badSig.statusCode).toBe(401);

    // Properly signed HMAC webhook upgrades workspace to PRO (500 clips/mo)
    const validSig = computeWebhookSignature(JSON.stringify(webhookPayload));
    const goodSig = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'x-billing-signature': validSig },
      payload: webhookPayload,
    });
    expect(goodSig.statusCode).toBe(200);
    expect(goodSig.json().data.workspace.planTier).toBe('PRO');
    expect(goodSig.json().data.workspace.monthlyClipLimit).toBe(500);

    // Now ingest succeeds again!
    const unblocked = await app.inject({
      method: 'POST',
      url: '/api/v1/clips/ingest',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        creatorId,
        sourceUrl: 'https://www.twitch.tv/videos/2933767012',
        title: 'Post Upgrade GTA Marathon Clip',
        startSec: 10,
        endSec: 25,
        transcriptText: 'GTA marathon clip unlocked after PRO upgrade',
      },
    });
    expect(unblocked.statusCode).toBe(201);

    // A channel without a supported feed must not create a synthetic clip.
    const scan = await app.inject({
      method: 'POST',
      url: '/api/v1/monitor/scan',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: { autoExecute: true },
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().data).toMatchObject({
      creatorsScanned: 0, unsupportedChannels: 1, unavailableChannels: [],
    });
    expect(scan.json().data.clipsCreated).toBe(0);
    expect(scan.json().data.postsRouted).toBe(0);

    const sync = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/sync-metrics',
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().data.syncedCount).toBeGreaterThanOrEqual(1);

    const analytics = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics',
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().data.totals.detectedVideosCount).toBe(0);
    expect(analytics.json().data.scope).toBe('SANDBOX_SIMULATED_TELEMETRY');
    expect(analytics.json().data.totals.totalViews).toBeGreaterThan(0);
    expect(analytics.json().data.platformBreakdown.length).toBeGreaterThanOrEqual(1);
    expect(analytics.json().data.insights.length).toBeGreaterThanOrEqual(1);

    // Cancel subscription downgrades cleanly to FREE
    const cancelSub = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/cancel',
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(cancelSub.statusCode).toBe(200);
    expect(cancelSub.json().data.planTier).toBe('FREE');
  });

  it('tracks a live stream until its replay becomes ready for clipping', async () => {
    const creator = await prisma.creatorAccount.findUniqueOrThrow({ where: { id: creatorId } });
    const externalVideoId = 'streamtest1';
    const where = { creatorId_externalVideoId: { creatorId, externalVideoId } };
    await prisma.creatorAccount.update({ where: { id: creatorId }, data: { platform: 'YOUTUBE' } });
    try {
      for (const [streamStatus, expected] of [['LIVE', 'LIVE'], ['FINALIZING', 'FINALIZING'], ['REPLAY', 'DETECTED']] as const) {
        await scanWorkspaceChannels({
          prisma, workspaceId: tenantAWorkspaceId, creatorId,
          discoverReplays: async () => [{
            externalVideoId, streamStatus, title: 'Fixture stream',
            videoUrl: 'https://www.youtube.com/watch?v=streamtest1', publishedAt: new Date(),
          }],
        });
        const source = await prisma.channelVideo.findUniqueOrThrow({ where });
        expect(source.detectionStatus).toBe(expected);
        expect(source.clipJobId).toBeNull();
      }
    } finally {
      await prisma.channelVideo.deleteMany({ where: { creatorId, externalVideoId } });
      await prisma.creatorAccount.update({ where: { id: creatorId }, data: { platform: creator.platform } });
    }
  });

  it('persists every unseen feed entry once without creating clips or charging quota', async () => {
    const creator = await prisma.creatorAccount.findUniqueOrThrow({ where: { id: creatorId } });
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: tenantAWorkspaceId } });
    const clipsBefore = await prisma.clipJob.count({ where: { workspaceId: tenantAWorkspaceId } });
    await prisma.creatorAccount.update({
      where: { id: creatorId },
      data: { platform: 'YOUTUBE', channelUrl: 'https://www.youtube.com/channel/UCfixture' },
    });
    const entry = (id: string) => `<entry><yt:videoId>${id}</yt:videoId><title>Recorded stream</title><published>2026-11-22T10:00:00Z</published></entry>`;
    const feed = `<feed>${entry('aaaaaaaaaaa')}${entry('bbbbbbbbbbb')}${entry('aaaaaaaaaaa')}</feed>`;
    const fetchFeed = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(feed));
    const scan = () => app.inject({
      method: 'POST',
      url: '/api/v1/monitor/scan',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: { creatorId },
    });
    try {
      const first = await scan();
      expect(first.statusCode).toBe(200);
      expect(first.json().data.detectedVideos.map((video: { externalVideoId: string }) => video.externalVideoId))
        .toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
      const replay = await scan();
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data.detectedVideos).toEqual([]);
      expect(await prisma.clipJob.count({ where: { workspaceId: tenantAWorkspaceId } })).toBe(clipsBefore);
      const after = await prisma.workspace.findUniqueOrThrow({ where: { id: tenantAWorkspaceId } });
      expect(after.clipsUsedThisPeriod).toBe(workspace.clipsUsedThisPeriod);
    } finally {
      fetchFeed.mockRestore();
      await prisma.creatorAccount.update({
        where: { id: creatorId },
        data: { platform: creator.platform, channelUrl: creator.channelUrl },
      });
    }
  });

  it('processes one source once and confirms each destination independently', async () => {
    const source = await prisma.channelVideo.findFirstOrThrow({ where: { creatorId, externalVideoId: 'aaaaaaaaaaa' } });
    const weak = await prisma.channelVideo.findFirstOrThrow({ where: { creatorId, externalVideoId: 'bbbbbbbbbbb' } });
    expect(selectHighlight([{ startSec: 5, endSec: 22, text: 'wow wow wow wow' }], () => 100)).toBeUndefined();
    for (const [key, value] of Object.entries({
      S3_ENDPOINT: 'https://storage.example', S3_BUCKET: 'media', S3_ACCESS_KEY_ID: 'fixture',
      S3_SECRET_ACCESS_KEY: 'fixture', POSTIZ_API_KEY: 'fixture-key',
      POSTIZ_API_BASE_URL: 'https://publishing.example/public/v1',
    })) vi.stubEnv(key, value);
    // Auto-publish is a per-workspace opt-in, changed by an admin through the API.
    const optIn = await app.inject({ method: 'PATCH', url: '/api/v1/workspace/automation',
      headers: { authorization: `Bearer ${tenantAToken}` }, payload: { autoPublishEnabled: true } });
    expect(optIn.statusCode).toBe(200);
    expect(optIn.json().data).toMatchObject({ autoPublishEnabled: true, workerConcurrency: expect.any(Number) });
    const initialWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: tenantAWorkspaceId } });
    await prisma.workspace.update({
      where: { id: tenantAWorkspaceId }, data: { monthlyClipLimit: initialWorkspace.clipsUsedThisPeriod + 2 },
    });
    const accounts = await prisma.socialAccount.findMany({ where: { id: { in: [manualAccountId, autoAccountId] } } });
    for (const account of accounts) {
      await prisma.socialAccount.update({
        where: { id: account.id },
        data: {
          autoPublishApproved: true, encryptedToken: encryptSecret(account.id), integrationMode: 'LIVE_OAUTH',
          platform: account.id === autoAccountId ? 'X' : 'INSTAGRAM_REELS',
        },
      });
    }
    let submissions = 0;
    const fetchFixture = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'storage.example') {
        if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '1024' } });
        const cues = url.pathname.includes(weak.id) ? [] : [
          { startSec: 40, endSec: 50, text: 'The GTA marathon squad found an unexpected route across the city.' },
          { startSec: 50, endSec: 60, text: 'Our driver jumped the barrier and the whole team escaped together.' },
        ];
        return Response.json({ durationSec: 75, cues });
      }
      if (url.pathname.endsWith('/upload-from-url')) return Response.json({ id: 'asset', path: 'https://publishing.example/asset.mp4' });
      if (init?.method === 'POST') {
        submissions++;
        const body = JSON.parse(String(init.body));
        expect(body.posts[0].value[0].image).toEqual([{ id: 'asset', path: 'https://publishing.example/asset.mp4' }]);
        expect(['x', 'instagram']).toContain(body.posts[0].settings.__type);
        return Response.json([{ postId: `post-${submissions}` }]);
      }
      return Response.json({ posts: [
        { id: 'post-1', state: 'PUBLISHED', releaseURL: 'https://destination.example/post-1' },
        { id: 'post-2', state: 'ERROR' },
      ] });
    });
    const render = vi.spyOn(renderService, 'renderStoredClip').mockImplementation(async (db, clip) => {
      expect(clip.startSec).toBe(39.75); // 0.25 s lead-in pause
      expect(clip.endSec).toBeCloseTo(60.35); // 0.35 s trailing pause
      expect(clip.automationSourceKey).toContain(source.id);
      return db.clipJob.update({ where: { id: clip.id }, data: { executionStatus: 'COMPLETED', outputMp4Path: 'rendered.mp4' } });
    });
    try {
      const upload = await app.inject({ method: 'POST', url: `/api/v1/monitor/videos/${source.id}/source-upload`,
        headers: { authorization: `Bearer ${tenantAToken}` } });
      expect(upload.statusCode).toBe(200);
      expect(new URL(upload.json().data.transcriptUploadUrl).pathname).toContain(source.id);
      const crossTenant = await app.inject({ method: 'POST', url: `/api/v1/monitor/videos/${source.id}/source-upload`,
        headers: { authorization: `Bearer ${tenantBToken}` } });
      expect(crossTenant.statusCode).toBe(404);

      const before = await prisma.workspace.findUniqueOrThrow({ where: { id: tenantAWorkspaceId } });
      const storage = getS3StorageConfig()!;
      await processWorkspaceSources(prisma, tenantAWorkspaceId, storage);
      await processWorkspaceSources(prisma, tenantAWorkspaceId, storage);
      const after = await prisma.workspace.findUniqueOrThrow({ where: { id: tenantAWorkspaceId } });
      expect(after.clipsUsedThisPeriod).toBe(before.clipsUsedThisPeriod + 1);
      expect(render).toHaveBeenCalledTimes(1);
      expect(submissions).toBe(2);
      const linked = await prisma.channelVideo.findUniqueOrThrow({ where: { id: source.id } });
      const posts = () => prisma.publishPost.findMany({ where: { clipJobId: linked.clipJobId! }, orderBy: { externalPostId: 'asc' } });
      expect((await posts()).map((post) => [post.status, post.publishedAt])).toEqual([['SUBMITTED', null], ['SUBMITTED', null]]);
      await reconcileSubmittedPosts(prisma, tenantAWorkspaceId);
      expect((await posts()).map((post) => post.status)).toEqual(['PUBLISHED_LIVE', 'FAILED']);
      expect((await prisma.channelVideo.findUniqueOrThrow({ where: { id: weak.id } })).detectionStatus).toBe('SKIPPED');

      await prisma.clipJob.update({ where: { id: linked.clipJobId! }, data: { executionStatus: 'FAILED' } });
      const retry = await app.inject({ method: 'POST', url: `/api/v1/clips/${linked.clipJobId}/retry`,
        headers: { authorization: `Bearer ${tenantAToken}` } });
      expect(retry.statusCode).toBe(202);
      expect(retry.json().data.executionStatus).toBe('QUEUED');
      expect(render).toHaveBeenCalledTimes(1);
      // The global kill switch stops automatic posting even for an opted-in workspace.
      vi.stubEnv('AUTO_PUBLISH_DISABLED', 'true');
      await processWorkspaceSources(prisma, tenantAWorkspaceId, storage);
      expect(render).toHaveBeenCalledTimes(2);
      expect(submissions).toBe(2);
    } finally {
      render.mockRestore();
      fetchFixture.mockRestore();
      vi.unstubAllEnvs();
      await prisma.workspace.update({
        where: { id: tenantAWorkspaceId }, data: { monthlyClipLimit: initialWorkspace.monthlyClipLimit, autoPublishEnabled: false },
      });
      for (const account of accounts) {
        const { autoPublishApproved, encryptedToken, integrationMode, platform } = account;
        await prisma.socialAccount.update({ where: { id: account.id }, data: { autoPublishApproved, encryptedToken, integrationMode, platform } });
      }
    }
  });

  it('deduplicates authorized connector events for a tagged creator', async () => {
    const payload = {
      creatorId, externalVideoId: '78210455', title: 'Connector stream',
      videoUrl: 'https://www.twitch.tv/videos/78210455', publishedAt: '2026-11-22T10:00:00Z',
    };
    const register = (token: string, videoUrl = payload.videoUrl) => app.inject({
      method: 'POST', url: '/api/v1/monitor/videos', headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, videoUrl },
    });
    expect((await register(tenantBToken)).statusCode).toBe(404);
    expect((await register(tenantAToken, 'https://kick.com/video/example')).statusCode).toBe(400);
    const first = await register(tenantAToken);
    const replay = await register(tenantAToken);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(first.json().data.id).toBe(replay.json().data.id);
  });

  it('syncs tagged creators and scopes connector callbacks to monitored sources', async () => {
    const adminToken = 'outbound-enrollment-secret';
    const ingressToken = 'inbound-source-secret';
    vi.stubEnv('SOURCE_CONNECTOR_WORKSPACE_ID', tenantAWorkspaceId);
    vi.stubEnv('SOURCE_CONNECTOR_INGRESS_TOKEN', ingressToken);
    vi.stubEnv('S3_ENDPOINT', 'https://storage.example');
    vi.stubEnv('S3_BUCKET', 'media');
    vi.stubEnv('S3_ACCESS_KEY_ID', 'fixture');
    vi.stubEnv('S3_SECRET_ACCESS_KEY', 'fixture');
    const put = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const config = { workspaceId: tenantAWorkspaceId, subscriptionsUrl: 'https://connector.example/subscriptions', adminToken };
    const payload = {
      creatorId, externalVideoId: '78210456', title: 'Managed connector stream',
      videoUrl: 'https://www.twitch.tv/videos/78210456', publishedAt: '2026-11-22T10:01:00Z',
    };
    const callback = (token: string) => app.inject({
      method: 'POST', url: '/api/v1/monitor/videos',
      headers: { 'x-source-connector-token': token }, payload,
    });
    try {
      await syncSourceConnectorSubscriptions(prisma, config);
      const [url, request] = put.mock.calls[0]!;
      expect(url).toBe(config.subscriptionsUrl);
      expect(request?.method).toBe('PUT');
      expect(request?.headers).toMatchObject({ Authorization: `Bearer ${adminToken}` });
      expect(JSON.parse(String(request?.body))).toMatchObject({
        workspaceId: tenantAWorkspaceId, subscriptions: [{ creatorId, platform: 'TWITCH' }],
      });
      expect(String(request?.body)).not.toContain(ingressToken);
      expect((await callback(adminToken)).statusCode).toBe(401);
      const accepted = await callback(ingressToken);
      expect(accepted.statusCode).toBe(200);
      expect((await callback(ingressToken)).json().data.id).toBe(accepted.json().data.id);
      const upload = () => app.inject({
        method: 'POST', url: `/api/v1/monitor/videos/${accepted.json().data.id}/source-upload`,
        headers: { 'x-source-connector-token': ingressToken, 'x-workspace-id': 'ignored' },
      });
      expect((await upload()).statusCode).toBe(200);
      expect((await app.inject({
        url: '/api/v1/monitor/videos', headers: { 'x-source-connector-token': ingressToken },
      })).statusCode).toBe(401);

      const paused = await app.inject({
        method: 'PATCH', url: `/api/v1/creators/${creatorId}`,
        headers: { authorization: `Bearer ${tenantAToken}` }, payload: { autoMonitorEnabled: false },
      });
      expect(paused.statusCode).toBe(200);
      expect(paused.json().data.autoMonitorEnabled).toBe(false);
      await syncSourceConnectorSubscriptions(prisma, config);
      expect(JSON.parse(String(put.mock.calls[1]?.[1]?.body)).subscriptions).toEqual([]);
      expect((await callback(ingressToken)).statusCode).toBe(404);
      expect((await upload()).statusCode).toBe(404);
    } finally {
      await prisma.creatorAccount.update({ where: { id: creatorId }, data: { autoMonitorEnabled: true } });
      put.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('9. Support tickets & Super-Admin RBAC (403 for normal user, 200 for SUPER_ADMIN)', async () => {
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: {
        subject: 'Need custom RTMP ingest help',
        message: 'Can we connect our agency Twitch multi-stream relay to Clip Network?',
        priority: 'HIGH',
      },
    });
    expect(ticket.statusCode).toBe(201);

    // Normal user blocked from admin panel (403)
    const nonAdmin = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    // Public registration must never provision a platform admin
    const regAdmin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Platform Admin',
        email: 'admin@clipnetwork.io',
        password: 'AdminPassword123',
        termsAccepted: true,
      },
    });
    expect(regAdmin.statusCode).toBe(201);
    adminToken = regAdmin.json().data.token;
    expect(regAdmin.json().data.user.systemRole).toBe('USER');
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const registered = await app.inject({ url: '/api/v1/admin/overview', headers: adminHeaders });
    expect(registered.statusCode).toBe(403);
    await prisma.user.update({
      where: { email: 'admin@clipnetwork.io' },
      data: { systemRole: 'SUPER_ADMIN' },
    });
    const unverified = await app.inject({ url: '/api/v1/admin/overview', headers: adminHeaders });
    expect(unverified.statusCode).toBe(403);
    await prisma.user.update({
      where: { email: 'admin@clipnetwork.io' },
      data: { emailVerifiedAt: new Date() },
    });

    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data.totals.users).toBe(3);
    expect(overview.json().data.totals.totalRevenueUsd).toBe(99);

    // Admin suspends Tenant A -> Tenant A token immediately rejected (401)
    const suspend = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${tenantAUserId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'SUSPENDED' },
    });
    expect(suspend.statusCode).toBe(200);

    const afterSuspend = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(afterSuspend.statusCode).toBe(401);
  });

  it('10. Logout invalidates active session token (401 on subsequent request)', async () => {
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('11. WORKFLOW 6: Team Invite -> Accept -> VIEWER blocked (403) -> Promote to MEMBER -> Permitted -> Remove', async () => {
    // Register Workspace Owner C & Teammate D
    const ownerC = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Agency Owner',
        email: 'owner-c@agency.io',
        password: 'Password123',
        workspaceName: 'Agency C',
        termsAccepted: true,
      },
    });
    const ownerToken = ownerC.json().data.token as string;
    const agencyWsId = ownerC.json().data.workspace.id as string;

    const teammateD = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Viewer Teammate',
        email: 'viewer-d@agency.io',
        password: 'Password123',
        termsAccepted: true,
      },
    });
    const teammateToken = teammateD.json().data.token as string;

    // Owner invites Teammate D as VIEWER
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/workspace/members/invite',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email: 'viewer-d@agency.io', role: 'VIEWER' },
    });
    expect(invite.statusCode).toBe(201);
    const inviteToken = invite.json().data.devInviteToken as string;
    expect(inviteToken).toBeTruthy();

    // Teammate D accepts invite
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/workspace/invites/accept',
      headers: { authorization: `Bearer ${teammateToken}` },
      payload: { token: inviteToken },
    });
    expect(accept.statusCode).toBe(200);
    const membershipId = accept.json().data.id as string;

    // Teammate D (VIEWER) tries to create a creator in Agency C -> 403 FORBIDDEN!
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/creators',
      headers: {
        authorization: `Bearer ${teammateToken}`,
        'x-workspace-id': agencyWsId,
      },
      payload: {
        handle: 'blocked_creator',
        displayName: 'Blocked',
        platform: 'TWITCH',
        channelUrl: 'https://www.twitch.tv/blocked_creator',
      },
    });
    expect(denied.statusCode).toBe(403);

    // Owner promotes Teammate D to MEMBER
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspace/members/${membershipId}/role`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role: 'MEMBER' },
    });
    expect(promote.statusCode).toBe(200);

    // Teammate D (now MEMBER) creates creator -> 201!
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/creators',
      headers: {
        authorization: `Bearer ${teammateToken}`,
        'x-workspace-id': agencyWsId,
      },
      payload: {
        handle: 'allowed_creator',
        displayName: 'Allowed',
        platform: 'TWITCH',
        channelUrl: 'https://www.twitch.tv/allowed_creator',
      },
    });
    expect(allowed.statusCode).toBe(201);

    // Owner removes member cleanly
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspace/members/${membershipId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(removed.statusCode).toBe(200);
  });

  it('12. SSRF HTTP guard (400), Notification prefs persistence, Media URL & Funnel telemetry', async () => {
    const ssrf = await app.inject({
      method: 'POST',
      url: '/api/v1/creators',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        handle: 'ssrf_probe',
        displayName: 'SSRF Probe',
        platform: 'TWITCH',
        channelUrl: 'http://169.254.169.254/latest/meta-data/',
      },
    });
    expect(ssrf.statusCode).toBe(400);
    expect(ssrf.json().errorCode).toBe('SSRF_BLOCKED');

    const saveNotif = await app.inject({
      method: 'PATCH',
      url: '/api/v1/account/notifications',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { approvals: true, failures: false, billing: true, security: true },
    });
    expect(saveNotif.statusCode).toBe(200);

    const readNotif = await app.inject({
      method: 'GET',
      url: '/api/v1/account/notifications',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(readNotif.statusCode).toBe(200);
    expect(readNotif.json().data.failures).toBe(false);

    const funnel = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/funnel',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(funnel.statusCode).toBe(200);
    expect(funnel.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it('13. Super Admin Control Center API: BI snapshot, workspaces override, jobs, security audit & support triage', async () => {
    const cc = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/control-center',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(cc.statusCode).toBe(200);
    const body = cc.json().data;
    expect(body.kpis.totalUsers).toBeGreaterThanOrEqual(3);
    expect(body.planEconomics.length).toBe(4);
    expect(body.integrations.length).toBe(6);

    const wsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/workspaces',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(wsRes.statusCode).toBe(200);
    const firstWsId = wsRes.json().data[0].id as string;

    const override = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/workspaces/${firstWsId}/plan`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { planTier: 'ENTERPRISE', subscriptionStatus: 'ACTIVE' },
    });
    expect(override.statusCode).toBe(200);
    expect(override.json().data.monthlyClipLimit).toBe(5000);

    const jobs = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().data.clips.length).toBeGreaterThanOrEqual(1);

    const sec = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/security',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(sec.statusCode).toBe(200);
    expect(sec.json().data.auditLogs.length).toBeGreaterThanOrEqual(1);
    expect(sec.json().data.sessions.length).toBeGreaterThanOrEqual(1);

    const tickets = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/support',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(tickets.statusCode).toBe(200);
    const ticketId = tickets.json().data[0].id as string;

    const resolve = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/support/${ticketId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'RESOLVED' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().data.status).toBe('RESOLVED');
  });
  it('14. Super admin saves integration keys that apply at once, encrypted, and never reach browsers', async () => {
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      name: 'Casey Integrations', email: 'casey@studio-c.io', password: 'Password123', workspaceName: 'Studio C', termsAccepted: true,
    } });
    expect(signup.statusCode).toBe(201);
    const userHeaders = { authorization: `Bearer ${signup.json().data.token}` };
    const previous = { app: process.env['PUBLIC_APP_URL'], key: process.env['ENCRYPTION_MASTER_KEY'] };
    process.env['PUBLIC_APP_URL'] = 'https://app.example.test';
    process.env['ENCRYPTION_MASTER_KEY'] = 'b'.repeat(64);
    delete process.env['X_CLIENT_ID'];
    delete process.env['X_CLIENT_SECRET'];
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/admin/integrations', headers: userHeaders })).statusCode).toBe(403);
      const bad = await app.inject({ method: 'PUT', url: '/api/v1/admin/integrations', headers: adminHeaders,
        payload: { values: { STRIPE_SECRET_KEY: 'pk_live_publishable' } } });
      expect(bad.statusCode).toBe(400);

      const before = await app.inject({ method: 'GET', url: '/api/v1/social-accounts/providers', headers: userHeaders });
      expect(before.json().data.find((p: { id: string }) => p.id === 'x').ready).toBe(false);

      const secret = 'x-client-secret-fixture-123';
      const saved = await app.inject({ method: 'PUT', url: '/api/v1/admin/integrations', headers: adminHeaders,
        payload: { values: { X_CLIENT_ID: 'x-client-id', X_CLIENT_SECRET: secret } } });
      expect(saved.statusCode).toBe(200);
      const row = await prisma.platformSetting.findUnique({ where: { key: 'X_CLIENT_SECRET' } });
      expect(row?.encryptedValue).toBeTruthy();
      expect(row?.encryptedValue).not.toContain(secret);

      const listing = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations', headers: adminHeaders });
      expect(listing.body).not.toContain(secret);
      const xGroup = listing.json().data.groups.find((g: { id: string }) => g.id === 'x');
      expect(xGroup.ready).toBe(true);
      expect(listing.json().data.redirectUri).toBe('https://app.example.test/social-accounts');

      const connect = await app.inject({ method: 'POST', url: '/api/v1/social-accounts/direct/x/connect', headers: userHeaders });
      expect(connect.statusCode).toBe(200);
      const authUrl = new URL(connect.json().data.url);
      expect(authUrl.hostname).toBe('x.com');
      expect(authUrl.searchParams.get('client_id')).toBe('x-client-id');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('redirect_uri')).toBe('https://app.example.test/social-accounts');

      const cleared = await app.inject({ method: 'PUT', url: '/api/v1/admin/integrations', headers: adminHeaders,
        payload: { values: { X_CLIENT_ID: null, X_CLIENT_SECRET: null } } });
      expect(cleared.statusCode).toBe(200);
      expect(process.env['X_CLIENT_ID']).toBeUndefined();

      // Linked account tokens never appear in any list a browser reads.
      for (const url of ['/api/v1/clips', '/api/v1/creators', '/api/v1/routes', '/api/v1/publish-queue', '/api/v1/social-accounts']) {
        const res = await app.inject({ method: 'GET', url, headers: userHeaders });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('encryptedToken');
      }
    } finally {
      process.env['PUBLIC_APP_URL'] = previous.app;
      process.env['ENCRYPTION_MASTER_KEY'] = previous.key;
      if (previous.app === undefined) delete process.env['PUBLIC_APP_URL'];
      if (previous.key === undefined) delete process.env['ENCRYPTION_MASTER_KEY'];
    }
  });
  it('15. Signs up and back in with Google, and shows a detected video with its stats and player', async () => {
    const previous = { app: process.env['PUBLIC_APP_URL'], id: process.env['GOOGLE_CLIENT_ID'], secret: process.env['GOOGLE_CLIENT_SECRET'] };
    process.env['PUBLIC_APP_URL'] = 'https://app.example.test';
    process.env['GOOGLE_CLIENT_ID'] = 'google-client';
    process.env['GOOGLE_CLIENT_SECRET'] = 'google-secret-fixture';
    const realFetch = globalThis.fetch;
    try {
      expect((await app.inject({ url: '/api/v1/auth/google/status' })).json().data.enabled).toBe(true);
      const start = await app.inject({ method: 'POST', url: '/api/v1/auth/google/start' });
      const authUrl = new URL(start.json().data.url);
      expect(authUrl.hostname).toBe('accounts.google.com');
      expect(authUrl.searchParams.get('redirect_uri')).toBe('https://app.example.test/auth/google');
      expect(authUrl.searchParams.get('scope')).toBe('openid email profile');
      const state = authUrl.searchParams.get('state')!;

      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'google-access' });
        if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
          return Response.json({ sub: '1', email: 'Gina@Example.test', email_verified: true, name: 'Gina Google' });
        }
        if (url.startsWith('https://www.youtube.com/watch')) {
          return new Response('<script>{"viewCount":"12345","lengthSeconds":"600","publishDate":"2026-11-20","likeCount":"321"}</script>');
        }
        return realFetch(input);
      }) as typeof fetch;

      const created = await app.inject({ method: 'POST', url: '/api/v1/auth/google/complete', payload: { state, code: 'auth-code' } });
      expect(created.statusCode).toBe(201);
      expect(created.json().data.user.email).toBe('gina@example.test');
      expect(created.json().data.user.emailVerified).toBe(true);
      // The state is single use.
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/google/complete', payload: { state, code: 'auth-code' } })).statusCode).toBe(409);

      const again = new URL((await app.inject({ method: 'POST', url: '/api/v1/auth/google/start' })).json().data.url).searchParams.get('state')!;
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/google/complete', payload: { state: again, code: 'auth-code-2' } });
      expect(login.statusCode).toBe(200);
      expect(login.json().data.created).toBe(false);
      const headers = { authorization: `Bearer ${login.json().data.token}` };

      const creator = await app.inject({ method: 'POST', url: '/api/v1/creators', headers, payload: {
        handle: 'gina', displayName: 'Gina', platform: 'YOUTUBE', channelUrl: 'https://www.youtube.com/@gina',
      } });
      expect(creator.statusCode).toBe(201);
      const creatorId = creator.json().data.id as string;
      const video = await prisma.channelVideo.create({ data: {
        workspaceId: login.json().data.workspace.id, creatorId, externalVideoId: 'abcdefghijk', title: 'Long stream',
        videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', detectionStatus: 'SKIPPED',
        thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
      } });

      const list = await app.inject({ url: `/api/v1/monitor/videos?creatorId=${creatorId}`, headers });
      expect(list.json().data.map((v: { id: string }) => v.id)).toEqual([video.id]);
      const details = await app.inject({ url: `/api/v1/monitor/videos/${video.id}/details`, headers });
      expect(details.statusCode).toBe(200);
      expect(details.json().data.embed).toEqual({ kind: 'YOUTUBE', id: 'abcdefghijk' });
      expect(details.json().data.stats).toMatchObject({ views: 12345, likes: 321, durationSec: 600 });

      const queued = await app.inject({ method: 'POST', url: `/api/v1/monitor/videos/${video.id}/clip`, headers });
      expect(queued.statusCode).toBe(202);
      expect((await prisma.channelVideo.findUniqueOrThrow({ where: { id: video.id } })).detectionStatus).toBe('DETECTED');
      // Another workspace cannot read it.
      expect((await app.inject({ url: `/api/v1/monitor/videos/${video.id}/details`, headers: { authorization: `Bearer ${adminToken}` } })).statusCode).toBe(404);
    } finally {
      globalThis.fetch = realFetch;
      for (const [key, value] of [['PUBLIC_APP_URL', previous.app], ['GOOGLE_CLIENT_ID', previous.id], ['GOOGLE_CLIENT_SECRET', previous.secret]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
