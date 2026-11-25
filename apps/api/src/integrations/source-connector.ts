import { createHash, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export interface SourceConnectorConfig {
  workspaceId: string;
  subscriptionsUrl: string;
  adminToken: string;
}

const platformHosts: Readonly<Record<string, readonly string[]>> = {
  YOUTUBE: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  TWITCH: ['twitch.tv', 'www.twitch.tv'],
  KICK: ['kick.com', 'www.kick.com'],
};

export function isCreatorPlatformUrl(platform: string, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (platformHosts[platform]?.includes(url.hostname) ?? false);
  } catch {
    return false;
  }
}

export function getSourceConnectorConfig(): SourceConnectorConfig | null {
  const subscriptionsUrl = process.env['SOURCE_CONNECTOR_SUBSCRIPTIONS_URL']?.trim();
  const adminToken = process.env['SOURCE_CONNECTOR_ADMIN_TOKEN']?.trim();
  const workspaceId = process.env['SOURCE_CONNECTOR_WORKSPACE_ID']?.trim();
  if (!subscriptionsUrl && !adminToken) return null;
  if (!subscriptionsUrl || !adminToken || !workspaceId) {
    throw new Error('Source connector requires a subscription URL, admin token and workspace ID');
  }

  const url = new URL(subscriptionsUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Source connector subscription URL must be an HTTPS endpoint');
  }
  return { workspaceId, subscriptionsUrl: url.href, adminToken };
}

/** Replace the scoped workspace's complete subscription set, including removal of old tags. */
export async function syncSourceConnectorSubscriptions(prisma: PrismaClient, config: SourceConnectorConfig) {
  const creators = await prisma.creatorAccount.findMany({
    where: { workspaceId: config.workspaceId, autoMonitorEnabled: true },
    select: { id: true, platform: true, handle: true, channelUrl: true },
    orderBy: { id: 'asc' },
  });
  const subscriptions = creators
    .filter((creator) => isCreatorPlatformUrl(creator.platform, creator.channelUrl))
    .map(({ id, ...details }) => ({ creatorId: id, ...details }));

  const response = await fetch(config.subscriptionsUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: config.workspaceId, subscriptions }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Connector rejected subscription snapshot (${response.status})`);
}

/** Connector ingress credentials only authorize source callbacks in one workspace. */
export function resolveSourceConnectorWorkspace(token: string): string | null {
  const expected = process.env['SOURCE_CONNECTOR_INGRESS_TOKEN']?.trim();
  const workspaceId = process.env['SOURCE_CONNECTOR_WORKSPACE_ID']?.trim();
  if (!expected || !workspaceId) return null;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(token), digest(expected)) ? workspaceId : null;
}
