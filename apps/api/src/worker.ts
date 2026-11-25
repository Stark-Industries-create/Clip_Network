import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { startBackgroundMonitorScheduler } from './integrations/scheduler.js';
import { scanWorkspaceChannels } from './services/channel-monitor.js';

import { getSourceConnectorConfig, syncSourceConnectorSubscriptions } from './integrations/source-connector.js';
import { getHostedTranscriptionConfig } from './integrations/hosted-transcription.js';
import { getHighlightLlmConfig } from './integrations/llm-highlights.js';
import { getS3StorageConfig } from './integrations/storage.js';
import { reconcileSubmittedPosts } from './services/publish-clip.js';
import { createRecordingAnalyzer } from './services/recording-analysis.js';
import { discoverRecordings } from './services/recording-sources.js';
import { startWorkerPool } from './services/worker-pool.js';
import { checkYouTubeSourceTools } from './services/youtube-source.js';

import { assertProductionConfig } from './production-config.js';
import { loadPlatformSettings, refreshPlatformSettings } from './platform-settings.js';

assertProductionConfig('worker');
const prisma = new PrismaClient();
// Integration credentials saved by a super admin (social logins, email) override the environment.
await loadPlatformSettings(prisma);
setInterval(() => void refreshPlatformSettings(prisma), 30_000).unref();
const automationEnabled = process.env['SOURCE_AUTOMATION_ENABLED'] === 'true';
const storage = getS3StorageConfig();
const connector = getSourceConnectorConfig();
// Transcription for recordings without captions (Twitch, Kick) and for exact clip edges: a hosted
// Whisper API when configured, local whisper otherwise (and as the hosted API's fallback).
const whisperModel = (process.env['RECORDING_WHISPER_MODEL'] || process.env['YOUTUBE_WHISPER_MODEL'])?.trim() || undefined;
const asr = getHostedTranscriptionConfig();
// Optional LLM ranking of viral moments; the rule-based ranking is used without it.
const llm = getHighlightLlmConfig();
const concurrency = Math.min(32, Math.max(1, Number(process.env['WORKER_CONCURRENCY'] ?? 2) || 2));
if (automationEnabled && !storage) throw new Error('Source automation requires S3 storage');
if (connector && !automationEnabled) throw new Error('Enable source automation before configuring a connector');
if ((whisperModel || asr) && !automationEnabled) throw new Error('Recording analysis requires source automation');
if (llm && !whisperModel && !asr) throw new Error('LLM ranking needs a transcription source (local whisper model or hosted API)');
if (whisperModel || asr) await checkYouTubeSourceTools(whisperModel);
const analyzer = whisperModel || asr ? createRecordingAnalyzer({ modelPath: whisperModel, asr, llm }) : undefined;

const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ level: 'info', service: '@clip-network/worker', ...event }));
log({ event: 'WORKER_STARTED', intervalMs: Number(process.env['CHANNEL_MONITOR_INTERVAL_MS'] ?? 300_000), concurrency, analyzer: !!analyzer,
  localWhisper: !!whisperModel, hostedTranscription: !!asr, llmRanking: !!llm });

// Discovery is cheap (listings only), so it runs for every workspace on an interval.
const stopDiscovery = startBackgroundMonitorScheduler(prisma, async (workspaceId) => {
  const result = await scanWorkspaceChannels({
    prisma,
    workspaceId,
    connectorManaged: connector?.workspaceId === workspaceId,
    ...(analyzer ? { discoverReplays: discoverRecordings } : {}),
  });
  await reconcileSubmittedPosts(prisma, workspaceId);
  if (result) log({ event: 'WORKSPACE_SCAN_TICK', workspaceId, creatorsScanned: result.creatorsScanned, detected: result.detectedVideos.length });
}, connector ? () => syncSourceConnectorSubscriptions(prisma, connector) : undefined,
() => writeFile(join(tmpdir(), 'clip-network-worker-heartbeat'), String(Date.now())));

// Analysis, rendering and publishing run in a fair, plan-limited pool. Run more worker processes to scale out.
const stopPool = automationEnabled && storage
  ? startWorkerPool({ prisma, storage, analyzer, concurrency, log })
  : async () => {};

async function shutdown(signal: string) {
  log({ event: 'SHUTDOWN', signal });
  await Promise.all([stopDiscovery(), stopPool()]);
  await prisma.$disconnect();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
