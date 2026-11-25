import type { PrismaClient } from '@prisma/client';
import { SAAS_PLANS, type PlanTier } from '@clip-network/shared';
import type { S3StorageConfig } from '../integrations/storage.js';
import { dueMetricPosts, dueMetricsWhere, refreshPostMetrics } from './post-metrics.js';
import { autoPublishAllowed, publishClipPost } from './publish-clip.js';
import { RENDER_LEASE_MS, renderStoredClip } from './render-clip.js';
import { analyzeSource, readyClips, readyPosts, readySources, type RecordingAnalyzer } from './source-automation.js';

export type TaskKind = 'PUBLISH' | 'RENDER' | 'ANALYZE' | 'METRICS';

export interface PoolTask {
  workspaceId: string;
  kind: TaskKind;
  subjectId: string;
  run: () => Promise<unknown>;
}

interface PoolDeps {
  prisma: PrismaClient;
  storage: S3StorageConfig;
  analyzer?: RecordingAnalyzer | undefined;
}

/** Work items claimed by this process but not yet visible as running in the database. */
const inFlight = new Map<string, number>();
const claimedSubjects = new Set<string>();

/** Workspaces that have any ready work, least recently served first (never served goes first). */
export async function workspacesWithWork(prisma: PrismaClient) {
  const now = new Date();
  const [sources, clips, posts, metrics] = await Promise.all([
    prisma.channelVideo.findMany({
      where: { clipJobId: null, detectionStatus: 'DETECTED', creator: { autoMonitorEnabled: true },
        OR: [{ nextAutomationAttemptAt: null }, { nextAutomationAttemptAt: { lte: now } }] },
      distinct: ['workspaceId'], select: { workspaceId: true }, take: 1000,
    }),
    prisma.clipJob.findMany({
      where: { automationSourceKey: { not: null }, creator: { autoMonitorEnabled: true },
        OR: [{ executionStatus: 'QUEUED' }, { executionStatus: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - RENDER_LEASE_MS) } }] },
      distinct: ['workspaceId'], select: { workspaceId: true }, take: 1000,
    }),
    prisma.publishPost.findMany({
      where: { status: 'AWAITING_APPROVAL', socialAccount: { autoPublishApproved: true }, workspace: { autoPublishEnabled: true },
        clipJob: { automationSourceKey: { not: null }, executionStatus: 'COMPLETED' } },
      distinct: ['workspaceId'], select: { workspaceId: true }, take: 1000,
    }),
    prisma.publishPost.findMany({ where: dueMetricsWhere(now), distinct: ['workspaceId'], select: { workspaceId: true }, take: 1000 }),
  ]);
  const ids = [...new Set([...sources, ...clips, ...posts, ...metrics].map(row => row.workspaceId))];
  if (!ids.length) return [];
  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: ids }, subscriptionStatus: { not: 'CANCELLED' } },
    select: { id: true, planTier: true, lastServedAt: true },
  });
  return workspaces.sort((a, b) => (a.lastServedAt?.getTime() ?? 0) - (b.lastServedAt?.getTime() ?? 0));
}

/** Jobs a workspace is running right now, across every worker process (from database leases). */
export async function runningJobs(prisma: PrismaClient, workspaceId: string) {
  const now = new Date();
  const [analyses, renders] = await Promise.all([
    prisma.channelVideo.count({ where: { workspaceId, analysisStartedAt: { not: null }, nextAutomationAttemptAt: { gt: now } } }),
    prisma.clipJob.count({ where: { workspaceId, executionStatus: 'RUNNING', updatedAt: { gt: new Date(now.getTime() - RENDER_LEASE_MS) } } }),
  ]);
  return analyses + renders + (inFlight.get(workspaceId) ?? 0);
}

/**
 * Pick the next task with fair scheduling: workspaces take turns (least recently served first), each
 * runs at most its plan's `workerConcurrency` jobs at once, and inside a workspace publishing comes
 * before rendering, which comes before starting a new analysis.
 */
export async function nextTask({ prisma, storage, analyzer }: PoolDeps): Promise<PoolTask | null> {
  for (const workspace of await workspacesWithWork(prisma)) {
    const plan = SAAS_PLANS[workspace.planTier as PlanTier] ?? SAAS_PLANS.FREE;
    if (await runningJobs(prisma, workspace.id) >= plan.workerConcurrency) continue;
    const pick = async (): Promise<Omit<PoolTask, 'workspaceId'> | null> => {
      if (await autoPublishAllowed(prisma, workspace.id)) {
        const post = (await readyPosts(prisma, workspace.id, 5)).find(row => !claimedSubjects.has(row.id));
        if (post) return { kind: 'PUBLISH', subjectId: post.id, run: () => publishClipPost(prisma, post.id, workspace.id) };
      }
      const clip = (await readyClips(prisma, workspace.id, 5)).find(row => !claimedSubjects.has(row.id));
      if (clip) return { kind: 'RENDER', subjectId: clip.id, run: () => renderStoredClip(prisma, clip, storage) };
      const source = (await readySources(prisma, workspace.id, 5)).find(row => !claimedSubjects.has(row.id));
      if (source) return { kind: 'ANALYZE', subjectId: source.id, run: () => analyzeSource(prisma, source.id, storage, analyzer) };
      // 24 h and 72 h engagement snapshots: cheap, and never ahead of producing clips.
      const post = (await dueMetricPosts(prisma, workspace.id, 5)).find(row => !claimedSubjects.has(row.id));
      if (post) return { kind: 'METRICS', subjectId: post.id, run: () => refreshPostMetrics(prisma, post.id, true) };
      return null;
    };
    const task = await pick();
    if (!task) continue;
    await prisma.workspace.update({ where: { id: workspace.id }, data: { lastServedAt: new Date() } });
    return { ...task, workspaceId: workspace.id };
  }
  return null;
}

/**
 * Run `concurrency` task slots until stopped. Every task claims its own row atomically (lease or status
 * compare-and-set), so several worker processes can share the same database safely.
 */
export function startWorkerPool(deps: PoolDeps & { concurrency: number; idleMs?: number; log?: (event: Record<string, unknown>) => void }) {
  let stopping = false;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const slot = async (index: number) => {
    while (!stopping) {
      let task: PoolTask | null = null;
      try {
        task = await nextTask(deps);
      } catch (error) {
        console.error('Worker could not pick a task', error instanceof Error ? error.name : 'UnknownError');
      }
      if (!task) {
        await sleep(deps.idleMs ?? 5000);
        continue;
      }
      claimedSubjects.add(task.subjectId);
      inFlight.set(task.workspaceId, (inFlight.get(task.workspaceId) ?? 0) + 1);
      const started = Date.now();
      try {
        await task.run();
        deps.log?.({ event: 'TASK_DONE', slot: index, kind: task.kind, workspaceId: task.workspaceId, ms: Date.now() - started });
      } catch (error) {
        console.error('Worker task failed', task.kind, task.subjectId, error instanceof Error ? error.name : 'UnknownError');
      } finally {
        claimedSubjects.delete(task.subjectId);
        const remaining = (inFlight.get(task.workspaceId) ?? 1) - 1;
        if (remaining > 0) inFlight.set(task.workspaceId, remaining); else inFlight.delete(task.workspaceId);
      }
    }
  };
  const slots = Array.from({ length: Math.max(1, deps.concurrency) }, (_, index) => slot(index));
  return async () => {
    stopping = true;
    wake?.();
    await Promise.all(slots);
  };
}
