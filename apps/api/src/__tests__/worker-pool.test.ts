import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { S3StorageConfig } from '../integrations/storage.js';
import type { AnalysisOutcome } from '../services/recording-analysis.js';
import { analyzeSource } from '../services/source-automation.js';
import { nextTask } from '../services/worker-pool.js';
import { encodeDirectCredential } from '../integrations/direct-social.js';
import { dueMetricPosts, refreshPostMetrics, refreshStaleMetrics } from '../services/post-metrics.js';

const DB_PATH = join(process.cwd(), 'data', 'test-worker-pool.db');
const DB_URL = `file:${DB_PATH.replace(/\\/g, '/')}`;
const storage: S3StorageConfig = { endpoint: 'https://storage.example', bucket: 'media', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1' };

describe('Worker pool, plan limits and caption-first clips', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    rmSync(DB_PATH, { force: true });
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    const schema = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));
    const sql = execFileSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script'],
      { encoding: 'utf8', env: { ...process.env, DATABASE_URL: DB_URL } });
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const database = new DatabaseSync(DB_PATH);
    try { database.exec(sql); } finally { database.close(); }
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(DB_PATH, { force: true });
  });

  const clipFields = { layout: 'CENTER_CROP_9_16', captionStyle: 'CLEAN_MINIMAL', assScript: '', compliancePassed: true,
    complianceScore: 90, complianceReportJson: '{}' };

  async function workspaceWithClip(name: string, planTier = 'FREE', lastServedAt: Date | null = null) {
    const workspace = await prisma.workspace.create({ data: { name, slug: `${name}-${Date.now()}`, planTier, lastServedAt } });
    const creator = await prisma.creatorAccount.create({
      data: { workspaceId: workspace.id, handle: name, displayName: name, platform: 'TWITCH', channelUrl: `https://www.twitch.tv/${name}` },
    });
    const clip = await prisma.clipJob.create({
      data: { workspaceId: workspace.id, creatorId: creator.id, sourceUrl: 'https://www.twitch.tv/videos/1', title: name,
        startSec: 0, endSec: 20, durationSec: 20, transcript: 'x', automationSourceKey: 'k', executionStatus: 'QUEUED', ...clipFields },
    });
    return { workspace, creator, clip };
  }

  it('serves the least recently served workspace first and respects plan concurrency', async () => {
    const busy = await workspaceWithClip('busy', 'FREE', new Date(Date.now() - 60_000));
    const waiting = await workspaceWithClip('waiting', 'FREE', null);
    const first = await nextTask({ prisma, storage });
    expect(first).toMatchObject({ workspaceId: waiting.workspace.id, kind: 'RENDER', subjectId: waiting.clip.id });

    // FREE allows one job at a time: a fresh RUNNING render blocks that workspace until it finishes.
    await prisma.clipJob.update({ where: { id: waiting.clip.id }, data: { executionStatus: 'RUNNING' } });
    await prisma.clipJob.create({ data: { workspaceId: waiting.workspace.id, creatorId: waiting.creator.id, sourceUrl: 'u', title: 't',
      startSec: 30, endSec: 50, durationSec: 20, transcript: 'x', automationSourceKey: 'k', executionStatus: 'QUEUED', ...clipFields } });
    const second = await nextTask({ prisma, storage });
    expect(second).toMatchObject({ workspaceId: busy.workspace.id, subjectId: busy.clip.id });

    await prisma.clipJob.updateMany({ where: { workspaceId: { in: [busy.workspace.id, waiting.workspace.id] } }, data: { executionStatus: 'COMPLETED' } });
    expect(await nextTask({ prisma, storage })).toBeNull();
  });

  async function youtubeSource(planTier = 'PRO') {
    const workspace = await prisma.workspace.create({ data: { name: 'yt', slug: `yt-${Date.now()}-${Math.random()}`, planTier, monthlyClipLimit: 50 } });
    const creator = await prisma.creatorAccount.create({
      data: { workspaceId: workspace.id, handle: `h${Date.now()}${Math.random()}`, displayName: 'NASA', platform: 'YOUTUBE', channelUrl: 'https://www.youtube.com/@NASA' },
    });
    const source = await prisma.channelVideo.create({
      data: { workspaceId: workspace.id, creatorId: creator.id, externalVideoId: 'odcqeJnboxQ', title: 'Space Station Live',
        videoUrl: 'https://www.youtube.com/watch?v=odcqeJnboxQ', durationSec: 0, detectionStatus: 'DETECTED' },
    });
    return { workspace, creator, source };
  }

  it('creates section-rendered clips from caption-first analysis, charging recorded time and storing cost', async () => {
    const { workspace, source } = await youtubeSource();
    const cues = [
      { startSec: 96.4, endSec: 100.6, text: 'So how does nutritional biochemistry come into the mix?' },
      { startSec: 100.8, endSec: 118, text: 'Well, nutrition is more than what you eat, because the biochemistry of energy and vision matters.' },
    ];
    const highlight = { startSec: 96.15, endSec: 118.35, transcript: cues.map(c => c.text).join(' '), rank: 30, contentType: 'CONVERSATION',
      cues: cues.map(c => ({ ...c, startSec: c.startSec - 96.15, endSec: c.endSec - 96.15 })) };
    const manifest = { durationSec: 426, cues, mediaUrl: source.videoUrl, highlights: [highlight] };
    let stored = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => stored ? Response.json(manifest) : new Response(null, { status: 404 }));
    const cost = { transcriptSource: 'CAPTIONS', recordingSec: 426, wallSec: 95, audioBytes: 6_800_000, whisperAudioSec: 62, captionWords: 1313, candidatesRefined: 1 };
    const analyzer = vi.fn(async (): Promise<AnalysisOutcome> => { stored = true; return { status: 'READY', cost: cost as never }; });

    expect(await analyzeSource(prisma, source.id, storage, analyzer)).toBe(true);
    expect(analyzer).toHaveBeenCalledWith(expect.objectContaining({ platform: 'YOUTUBE', maxRecordingSec: 12 * 3600 }), storage, expect.any(String));
    const clips = await prisma.clipJob.findMany({ where: { sourceVideoId: source.id } });
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ sourceSectionUrl: source.videoUrl, sourceOffsetSec: 95, startSec: 96.15, executionStatus: 'QUEUED' });
    const after = await prisma.channelVideo.findUniqueOrThrow({ where: { id: source.id } });
    expect(after).toMatchObject({ detectionStatus: 'PROCESSING', analysisStartedAt: null });
    expect(JSON.parse(after.analysisCostJson)).toMatchObject({ transcriptSource: 'CAPTIONS', whisperAudioSec: 62 });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).analysisSecondsUsed).toBe(426);

    // A second attempt cannot create another clip or charge again.
    expect(await analyzeSource(prisma, source.id, storage, analyzer)).toBe(false);
    expect(analyzer).toHaveBeenCalledTimes(1);
  });

  it('skips recordings longer than the plan allows and stops when monthly analysis hours run out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const long = await youtubeSource('FREE');
    const tooLong = vi.fn(async (): Promise<AnalysisOutcome> => ({ status: 'TOO_LONG', durationSec: 3 * 3600 }));
    await analyzeSource(prisma, long.source.id, storage, tooLong);
    expect(await prisma.channelVideo.findUniqueOrThrow({ where: { id: long.source.id } })).toMatchObject({
      detectionStatus: 'SKIPPED', automationError: 'This 3.0-hour recording is longer than the plan allows (2 hours).',
    });

    const spent = await youtubeSource('FREE');
    await prisma.workspace.update({ where: { id: spent.workspace.id }, data: { analysisSecondsUsed: 5 * 3600 } });
    const never = vi.fn();
    await analyzeSource(prisma, spent.source.id, storage, never);
    expect(never).not.toHaveBeenCalled();
    expect((await prisma.channelVideo.findUniqueOrThrow({ where: { id: spent.source.id } })).automationError)
      .toBe("This plan's 5 hours of recording analysis are used up for this month.");
  });

  it('analyzes a recording once for all workspaces and lets each choose under its own rules, charging each', async () => {
    const make = async (name: string, banned: string[]) => {
      const workspace = await prisma.workspace.create({ data: { name, slug: `${name}-${Date.now()}-${Math.random()}`, planTier: 'PRO', monthlyClipLimit: 50 } });
      const creator = await prisma.creatorAccount.create({ data: {
        workspaceId: workspace.id, handle: `${name}${Math.random()}`, displayName: name, platform: 'YOUTUBE',
        channelUrl: 'https://www.youtube.com/@Shared', bannedKeywordsJson: JSON.stringify(banned),
      } });
      const source = await prisma.channelVideo.create({ data: {
        workspaceId: workspace.id, creatorId: creator.id, externalVideoId: 'sharedVid01', title: 'Shared stream',
        videoUrl: 'https://www.youtube.com/watch?v=sharedVid01', durationSec: 0, detectionStatus: 'DETECTED',
      } });
      return { workspace, source };
    };
    const agencyA = await make('agencyA', []);
    const agencyB = await make('agencyB', ['casino']);
    const clipAt = (startSec: number, text: string, rank: number) => ({
      startSec, endSec: startSec + 20, transcript: text, rank, contentType: 'COMMENTARY',
      cues: [{ startSec: 0, endSec: 20, text }],
    });
    const manifest = {
      durationSec: 600, mediaUrl: 'https://www.youtube.com/watch?v=sharedVid01',
      cues: [{ startSec: 100, endSec: 120, text: 'The casino jackpot moment was unreal for everyone watching.' },
        { startSec: 300, endSec: 320, text: 'The rocket landing finally worked after years of failed attempts.' }],
      highlights: [clipAt(100, 'The casino jackpot moment was unreal for everyone watching.', 95),
        clipAt(300, 'The rocket landing finally worked after years of failed attempts.', 80)],
    };
    const stored = new Set<string>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      return stored.has(path) ? Response.json(manifest) : new Response(null, { status: 404 });
    });
    const analyzer = vi.fn(async (request: { requiredTopics: readonly string[]; bannedKeywords: readonly string[]; candidatePool?: number },
      _storage: unknown, prefix: string): Promise<AnalysisOutcome> => {
      // The shared run sees no workspace's rules and asks for a wider pool.
      expect(request).toMatchObject({ requiredTopics: [], bannedKeywords: [], candidatePool: 3 });
      expect(prefix).toBe('shared/recordings/youtube/sharedVid01/auto');
      stored.add(`/media/${prefix}/transcript.json`);
      return { status: 'READY', cost: { transcriptSource: 'CAPTIONS', recordingSec: 600 } as never };
    });

    await analyzeSource(prisma, agencyA.source.id, storage, analyzer as never);
    await analyzeSource(prisma, agencyB.source.id, storage, analyzer as never);
    expect(analyzer).toHaveBeenCalledTimes(1);

    const clipsOf = (sourceId: string) => prisma.clipJob.findMany({ where: { sourceVideoId: sourceId }, select: { startSec: true } });
    expect(await clipsOf(agencyA.source.id)).toEqual([{ startSec: 100 }]);
    // Agency B bans "casino", so it gets the next-best shared moment instead.
    expect(await clipsOf(agencyB.source.id)).toEqual([{ startSec: 300 }]);
    for (const agency of [agencyA, agencyB]) {
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: agency.workspace.id } })).analysisSecondsUsed).toBe(600);
    }
    const costB = JSON.parse((await prisma.channelVideo.findUniqueOrThrow({ where: { id: agencyB.source.id } })).analysisCostJson);
    expect(costB).toMatchObject({ cacheHit: true, transcriptSource: 'CAPTIONS' });
  });

  it('waits instead of analyzing twice while another worker holds the recording', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const { source } = await youtubeSource('PRO');
    // Another worker holds a fresh lease on this recording.
    const held = { status: 'RUNNING', leaseUntil: new Date(Date.now() + 60_000) };
    await prisma.recordingAnalysis.upsert({
      where: { platform_externalVideoId_spokenLanguage: { platform: 'YOUTUBE', externalVideoId: source.externalVideoId, spokenLanguage: 'auto' } },
      create: { platform: 'YOUTUBE', externalVideoId: source.externalVideoId, spokenLanguage: 'auto', ...held },
      update: held,
    });
    const analyzer = vi.fn();
    await analyzeSource(prisma, source.id, storage, analyzer);
    expect(analyzer).not.toHaveBeenCalled();
    expect((await prisma.channelVideo.findUniqueOrThrow({ where: { id: source.id } })).automationError)
      .toBe('Analysis in progress. The worker will check again shortly.');
    await prisma.recordingAnalysis.deleteMany({ where: { externalVideoId: source.externalVideoId } });
  });

  async function publishedPost(status: string, publishedAgoHours: number, extra: Record<string, unknown> = {}) {
    const { workspace, creator, clip } = await workspaceWithClip(`m${Math.random().toString(36).slice(2, 8)}`, 'PRO');
    const account = await prisma.socialAccount.create({ data: {
      workspaceId: workspace.id, platform: 'YOUTUBE_SHORTS', accountHandle: '@dest', accountName: 'Dest', ...(extra['account'] as object ?? {}),
    } });
    const post = await prisma.publishPost.create({ data: {
      workspaceId: workspace.id, clipJobId: clip.id, socialAccountId: account.id, idempotencyKey: `k-${Math.random()}`,
      platform: 'YOUTUBE_SHORTS', captionText: 'c', status, publishedAt: new Date(Date.now() - publishedAgoHours * 3600_000),
      ...(extra['post'] as object ?? {}),
    } });
    return { workspace, creator, post };
  }

  it('schedules platform metrics at 24 and 72 hours and never invents numbers for real posts', async () => {
    const tooSoon = await publishedPost('PUBLISHED_LIVE', 10, { post: { directProvider: 'youtube', externalPostId: 'vid' } });
    const due24 = await publishedPost('PUBLISHED_LIVE', 25, { post: { directProvider: 'youtube', externalPostId: 'vid' } });
    const due72 = await publishedPost('PUBLISHED_LIVE', 73, { post: { directProvider: 'youtube', externalPostId: 'vid', metricsStage: 1 } });
    expect(await dueMetricPosts(prisma, tooSoon.workspace.id)).toEqual([]);
    expect(await dueMetricPosts(prisma, due24.workspace.id)).toEqual([{ id: due24.post.id }]);
    expect(await dueMetricPosts(prisma, due72.workspace.id)).toEqual([{ id: due72.post.id }]);

    // A real YouTube post reads its numbers from the YouTube Data API and moves past its checkpoint.
    const credential = encodeDirectCredential({ provider: 'youtube', id: 'channel', accessToken: 'token', expiresAt: Date.now() + 3600_000 });
    await prisma.socialAccount.update({ where: { id: due24.post.socialAccountId }, data: { encryptedToken: credential } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toContain('youtube/v3/videos?part=statistics&id=vid');
      return Response.json({ items: [{ statistics: { viewCount: '1234', likeCount: '56', commentCount: '7' } }] });
    });
    expect(await refreshPostMetrics(prisma, due24.post.id, true)).toBe('LIVE');
    const live = await prisma.publishPost.findUniqueOrThrow({ where: { id: due24.post.id }, include: { metricSnapshots: true } });
    expect(live.metricsStage).toBe(1);
    expect(live.metricSnapshots).toEqual([expect.objectContaining({ views: 1234, likes: 56, comments: 7, sourceMode: 'LIVE_PLATFORM_API' })]);

    // Without a direct connection there is no platform source: no snapshot, a clear reason instead.
    const postiz = await publishedPost('PUBLISHED_LIVE', 30, { post: { externalPostId: 'postiz-post-1' } });
    expect(await refreshPostMetrics(prisma, postiz.post.id)).toBe('UNSUPPORTED');
    const none = await prisma.publishPost.findUniqueOrThrow({ where: { id: postiz.post.id }, include: { metricSnapshots: true } });
    expect(none.metricSnapshots).toEqual([]);
    expect(none.metricsError).toMatch(/Postiz/);
  });

  it('refreshes dashboards lazily: posts checked in the last six hours are not fetched again', async () => {
    const fresh = await publishedPost('PUBLISHED_SANDBOX', 5);
    const first = await refreshStaleMetrics(prisma, fresh.workspace.id);
    expect(first).toMatchObject({ refreshed: 1, outcomes: { SIMULATED: 1 } });
    const second = await refreshStaleMetrics(prisma, fresh.workspace.id);
    expect(second.refreshed).toBe(0);
    await prisma.publishPost.update({ where: { id: fresh.post.id }, data: { metricsCheckedAt: new Date(Date.now() - 7 * 3600_000) } });
    expect((await refreshStaleMetrics(prisma, fresh.workspace.id)).refreshed).toBe(1);
  });
});
