import { PrismaClient } from '@prisma/client';
import { buildServer } from './server.js';
import { startBackgroundMonitorScheduler } from './integrations/scheduler.js';

import { reconcileSubmittedPosts } from './services/publish-clip.js';

import { assertProductionConfig } from './production-config.js';
import { loadPlatformSettings } from './platform-settings.js';

assertProductionConfig('api');
const prisma = new PrismaClient();
const app = buildServer(prisma);

const port = Number(process.env['PORT'] ?? 4100);
const host = process.env['HOST'] ?? '0.0.0.0';

let stopMonitoring: (() => Promise<void>) | undefined;

prisma.$connect()
  .then(() => loadPlatformSettings(prisma))
  .then(() => app.listen({ port, host }))
  .then(() => {
    console.log(`@clip-network/api listening on http://${host}:${port}`);
    stopMonitoring = startBackgroundMonitorScheduler(prisma, async (workspaceId) => {
      await prisma.creatorAccount.updateMany({
        where: { workspaceId, autoMonitorEnabled: true },
        data: { lastPolledAt: new Date() },
      });
      await reconcileSubmittedPosts(prisma, workspaceId);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

async function shutdown() {
  try {
    await Promise.all([app.close(), stopMonitoring?.()]);
  } finally {
    await prisma.$disconnect();
  }
}

process.once('SIGTERM', () => void shutdown().catch(() => { process.exitCode = 1; }));
process.once('SIGINT', () => void shutdown().catch(() => { process.exitCode = 1; }));
