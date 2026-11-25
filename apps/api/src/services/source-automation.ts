import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { buildWordSyncedAss, SENTENCE_END, type TimedSpeechCue } from '@clip-network/clip-engine';

/** Letters, combining marks (Devanagari vowel signs are \p{M}) and digits form one word. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/**
 * Payoff cues. `\b` does not work around Devanagari, so Hindi and Nepali terms are matched as plain
 * substrings: because (क्योंकि, किनभने, किनकि), finally (आखिरकार, अन्ततः, अन्त्यमा), realised (एहसास, थाहा पायो).
 */
const PAYOFF = /\b(because|finally|turns out|instead|realized|won|discovered|solved)\b|क्योंकि|किनभने|किनकि|आखिरकार|अन्ततः|अन्त्यमा|एहसास|थाहा पायो/i;
import { evaluateClipCompliance, SAAS_PLANS, type CaptionStyleId, type PlanTier } from '@clip-network/shared';
import { ensureCurrentBillingPeriod } from '../billing-period.js';
import { isCreatorPlatformUrl } from '../integrations/source-connector.js';
import { buildSourceBundlePrefix, createPresignedS3Url, type S3StorageConfig } from '../integrations/storage.js';
import type { AnalysisOutcome, AnalysisRequest } from './recording-analysis.js';
import { autoPublishAllowed, publishClipPost } from './publish-clip.js';
import { MAX_SOURCE_BYTES, RENDER_LEASE_MS, renderStoredClip } from './render-clip.js';

interface SourceTranscript {
  durationSec: number;
  chunkSeconds?: number;
  beats?: number[];
  /** Loud audio moments (crowd, reactions, impacts) in recording seconds. */
  peaks?: number[];
  /** Hard scene changes in recording seconds, used to snap action cuts. */
  scenes?: number[];
  cues: TimedSpeechCue[];
  highlight?: { startSec: number; endSec: number };
  /** Platform recording URL. When set, clips render from sections of it instead of stored media. */
  mediaUrl?: string;
  /** Candidates already selected and refined during analysis. */
  highlights?: SelectedHighlight[];
}

function parseTranscript(raw: unknown): SourceTranscript {
  const { durationSec, cues, highlight, chunkSeconds, beats, peaks, scenes, mediaUrl, highlights } = (raw ?? {}) as Partial<SourceTranscript>;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0 ||
    !Array.isArray(cues) || cues.length > 100000) {
    throw new Error('Invalid source transcript');
  }

  let previousEnd = 0;
  for (const cue of cues) {
    if (!cue || !Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) ||
      cue.startSec < previousEnd || cue.endSec <= cue.startSec || cue.endSec > durationSec ||
      typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 1000 ||
      (cue.speaker !== undefined && (typeof cue.speaker !== 'string' || cue.speaker.length > 32))) {
      throw new Error('Invalid timed speech cue');
    }
    previousEnd = cue.endSec;
  }
  if (highlight !== undefined && (!highlight || !Number.isFinite(highlight.startSec) ||
    !Number.isFinite(highlight.endSec) || highlight.startSec < 0 || highlight.endSec > durationSec ||
    highlight.endSec - highlight.startSec < 12 || highlight.endSec - highlight.startSec > 60 ||
    !cues.some((cue) => cue.startSec >= highlight.startSec && cue.endSec <= highlight.endSec) ||
    cues.some((cue) => (cue.startSec < highlight.startSec && cue.endSec > highlight.startSec) ||
      (cue.startSec < highlight.endSec && cue.endSec > highlight.endSec)))) {
    throw new Error('Invalid highlight range or a cut intersects speech');
  }
  if (chunkSeconds !== undefined && chunkSeconds !== 120) throw new Error("Invalid recording chunk size");
  const times = (value: unknown) => value === undefined || (Array.isArray(value) && value.length <= 200000 &&
    value.every(t => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= durationSec));
  if (!times(beats) || !times(peaks) || !times(scenes)) throw new Error("Invalid recording beats");
  if (mediaUrl !== undefined && (typeof mediaUrl !== 'string' || !/^https:\/\//.test(mediaUrl) || mediaUrl.length > 500)) {
    throw new Error('Invalid recording URL');
  }
  if (highlights !== undefined && (!Array.isArray(highlights) || highlights.length > 500 || highlights.some(h =>
    !h || !Number.isFinite(h.startSec) || !Number.isFinite(h.endSec) || h.startSec < 0 || h.endSec > durationSec ||
    h.endSec - h.startSec < 5 || h.endSec - h.startSec > 60 || typeof h.transcript !== 'string' || !Array.isArray(h.cues) ||
    !['CONVERSATION', 'GAMEPLAY', 'COMMENTARY'].includes(h.contentType) ||
    h.cues.some(c => !c || typeof c.text !== 'string' || !Number.isFinite(c.startSec) || !Number.isFinite(c.endSec))))) {
    throw new Error('Invalid selected highlights');
  }
  return {
    durationSec, cues, ...(beats ? { beats } : {}), ...(peaks ? { peaks } : {}), ...(scenes ? { scenes } : {}),
    ...(chunkSeconds ? { chunkSeconds } : {}), ...(highlight ? { highlight } : {}),
    ...(mediaUrl ? { mediaUrl } : {}), ...(highlights ? { highlights } : {}),
  };
}

export interface SpeakerTurn { start: number; end: number; speaker: string }

/** Merge consecutive cues from the same diarized voice into turns. Unlabelled cues are skipped. */
export function speakerTurns(cues: readonly TimedSpeechCue[], originSec = 0): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const cue of cues) {
    if (!cue.speaker) continue;
    const last = turns.at(-1);
    const ms = (sec: number) => Math.round((sec - originSec) * 1000) / 1000;
    if (last && last.speaker === cue.speaker) last.end = ms(cue.endSec);
    else turns.push({ start: ms(cue.startSec), end: ms(cue.endSec), speaker: cue.speaker });
  }
  return turns;
}

/**
 * Show furniture, not moments: greetings, guest introductions, thank-yous, sign-offs and calls to
 * subscribe. They read as tidy self-contained exchanges, so without a penalty they win on structure.
 */
const BOILERPLATE = /\b(thanks? (so much |again |you )?(for (joining|watching|having|coming)|everyone)|welcome (back|to)|joining (me|us) (today|now)|pleasure to be here|subscribe|that'?s all (for|we)|see you (next|soon)|until next time|stay tuned|like and share)\b/i;

export function selectHighlight(cues: readonly TimedSpeechCue[], score: (transcript: string) => number, beats: readonly number[] = [],
  durationSec?: number) {
  let best: { startSec: number; endSec: number; transcript: string; cues: TimedSpeechCue[]; rank: number } | undefined;
  const hasCapitalization = cues.some(part => /^[A-Z]/.test(part.text.trim()));
  for (const [index, first] of cues.entries()) {
    const window: TimedSpeechCue[] = [];
    // End time of the last question asked in this window. Transcribers split speech into short
    // lines, so a question is rarely a single line that also opens the window.
    let questionEndSec: number | undefined;
    let target = 22;
    for (let i = index; i < cues.length; i++) {
      const cue = cues[i]!;
      const duration = cue.endSec - first.startSec;
      const previous = window.at(-1);
      // An answer that depends on an early question may run longer than a standalone remark.
      const earlyQuestion = questionEndSec !== undefined && questionEndSec - first.startSec <= 15;
      const cap = earlyQuestion ? 45 : 30;
      target = earlyQuestion ? 32 : 22;
      if (duration > cap || window.length === 40 || (previous && cue.startSec - previous.endSec > 4)) break;
      window.push(cue);
      if (/\?["')\]]?$/.test(cue.text.trim())) questionEndSec = cue.endSec;
      if (duration < 12) continue;

      const transcript = window.map((part) => part.text.trim()).join(' ');
      const words = transcript.match(WORD) ?? [];
      const distinctWords = new Set(words.map((word) => word.toLowerCase())).size;
      if (distinctWords < 12 || distinctWords / words.length < 0.45) continue;
      const quality = score(transcript);
      if (!quality) continue;
      const closesThought = SENTENCE_END.test(cue.text.trim());
      const opensThought = index === 0 || SENTENCE_END.test(cues[index - 1]!.text.trim());
      if (/^[a-z]/.test(first.text.trim()) && hasCapitalization) continue;
      if (!closesThought && cues[i+1] && cues[i+1]!.startSec - cue.endSec < 0.6) continue;
      const previousText = cues[index - 1]?.text.trim() ?? '';
      const startsWithAnswer = /[?]$/.test(previousText) && first.startSec - cues[index - 1]!.endSec < 2;
      if (startsWithAnswer || /[?]$/.test(cue.text.trim())) continue;
      const questionAnswer = questionEndSec !== undefined;
      // A real back-and-forth between voices reads as a self-contained exchange.
      const exchange = speakerTurns(window).length > 1;
      const next = cues[i + 1];
      const continuesAtOnce = !!next && next.startSec - cue.endSec < 1;
      // Ending right after a short answer while speech carries on usually cuts off the real answer.
      const answerCutShort = questionEndSec !== undefined && continuesAtOnce && cue.endSec - questionEndSec < 20;
      // Ending while the same voice keeps talking cuts the speaker off mid-turn.
      const midTurn = continuesAtOnce && !!cue.speaker && next!.speaker === cue.speaker;
      const payoff = PAYOFF.test(transcript);
      const beat = beats.some(t => t >= first.startSec && t <= cue.endSec);
      const boilerplate = BOILERPLATE.test(transcript);
      // Openings and closings of a recording are mostly intros and sign-offs.
      const atEdge = durationSec !== undefined && (first.startSec < durationSec * 0.05 || cue.endSec > durationSec * 0.95);
      const rank = (opensThought ? 6 : -8) + (closesThought ? 8 : -12) +
        (questionAnswer ? 5 : 0) + (exchange ? 4 : 0) - (answerCutShort ? 12 : 0) - (midTurn ? 10 : 0) + (payoff ? 5 : 0) + (beat ? 5 : 0) +
        quality + Math.min(24, distinctWords) - Math.abs(duration - target) - (boilerplate ? 20 : 0) - (atEdge ? 8 : 0);
      if (best && best.rank >= rank) continue;
      best = {
        startSec: first.startSec, endSec: cue.endSec, transcript, rank,
        cues: window.map((part) => ({
          ...part, startSec: part.startSec - first.startSec, endSec: part.endSec - first.startSec,
        })),
      };
    }
  }
  return best;
}

export type SegmentContentType = 'CONVERSATION' | 'GAMEPLAY' | 'COMMENTARY';

export interface SelectedHighlight {
  startSec: number;
  endSec: number;
  transcript: string;
  cues: TimedSpeechCue[];
  rank: number;
  contentType: SegmentContentType;
}

function speechSeconds(cues: readonly TimedSpeechCue[], startSec: number, endSec: number) {
  return cues.reduce((sum, cue) => sum + Math.max(0, Math.min(endSec, cue.endSec) - Math.max(startSec, cue.startSec)), 0);
}

/** Label one stretch of a recording so streams can move between talk, play and narration. */
export function classifySegment(cues: readonly TimedSpeechCue[], startSec: number, endSec: number,
  peaks: readonly number[] = []): SegmentContentType {
  const length = Math.max(0.001, endSec - startSec);
  const inside = cues.filter(cue => cue.endSec > startSec && cue.startSec < endSec);
  const speechRatio = speechSeconds(inside, startSec, endSec) / length;
  const peakCount = peaks.filter(t => t >= startSec && t <= endSec).length;
  if (speechRatio < 0.4 && peakCount > 0) return 'GAMEPLAY';
  if (speechRatio < 0.25) return 'GAMEPLAY';
  const questions = inside.filter(cue => /\?["')\]]?$/.test(cue.text.trim())).length;
  const voices = new Set(inside.flatMap(cue => (cue.speaker ? [cue.speaker] : []))).size;
  return questions > 0 || voices > 1 ? 'CONVERSATION' : 'COMMENTARY';
}

function relativeCues(cues: readonly TimedSpeechCue[], startSec: number, endSec: number) {
  return cues.filter(cue => cue.startSec >= startSec && cue.endSec <= endSec)
    .map(cue => ({ ...cue, startSec: cue.startSec - startSec, endSec: cue.endSec - startSec }));
}

/**
 * Build setup-action-reaction windows around loud moments where speech is sparse.
 * Cuts never land inside a spoken phrase, and prefer a nearby scene change.
 */
export function selectActionMoments(manifest: Pick<SourceTranscript, 'durationSec' | 'cues' | 'peaks' | 'scenes'>,
  score: (text: string) => number): SelectedHighlight[] {
  const { cues, durationSec } = manifest;
  const peaks = [...(manifest.peaks ?? [])].sort((a, b) => a - b);
  const scenes = manifest.scenes ?? [];
  const moments: SelectedHighlight[] = [];
  const straddling = (t: number) => cues.find(cue => cue.startSec < t && cue.endSec > t);
  for (const peak of peaks) {
    let startSec = Math.max(0, peak - 10);
    let endSec = Math.min(durationSec, peak + 8);
    const scene = scenes.filter(t => t <= startSec && t >= startSec - 3).at(-1);
    if (scene !== undefined && !straddling(scene)) startSec = scene;
    const openCue = straddling(startSec);
    if (openCue) startSec = openCue.startSec;
    const closeCue = straddling(endSec);
    if (closeCue) endSec = closeCue.endSec - peak <= 20 ? closeCue.endSec : closeCue.startSec;
    endSec = Math.min(durationSec, endSec);
    if (endSec - startSec < 12 || endSec - startSec > 45) continue;
    if (classifySegment(cues, startSec, endSec, peaks) !== 'GAMEPLAY') continue;
    const windowCues = relativeCues(cues, startSec, endSec);
    const transcript = windowCues.map(cue => cue.text.trim()).join(' ');
    const quality = score(transcript);
    if (!quality) continue;
    const density = peaks.filter(t => t >= startSec && t <= endSec).length;
    const reaction = cues.some(cue => cue.startSec >= peak && cue.startSec <= endSec);
    moments.push({
      startSec, endSec, transcript, cues: windowCues, contentType: 'GAMEPLAY',
      rank: 10 + Math.min(5, density) * 3 + (reaction ? 6 : 0) + Math.min(10, quality / 10) - Math.abs(endSec - startSec - 22) / 2,
    });
  }
  return moments;
}

/** Leave a short natural pause on either side without reaching into the neighbouring phrase. */
export function padToPauses(candidate: SelectedHighlight, cues: readonly TimedSpeechCue[], durationSec: number): SelectedHighlight {
  const before = cues.filter(cue => cue.endSec <= candidate.startSec).at(-1)?.endSec ?? 0;
  const after = cues.find(cue => cue.startSec >= candidate.endSec)?.startSec ?? durationSec;
  const startSec = Math.max(before, candidate.startSec - 0.25, 0);
  const endSec = Math.min(after, candidate.endSec + 0.35, durationSec, startSec + 60);
  return {
    ...candidate, startSec, endSec,
    cues: candidate.cues.map(cue => ({
      ...cue, startSec: cue.startSec + candidate.startSec - startSec, endSec: cue.endSec + candidate.startSec - startSec,
    })),
  };
}

/**
 * A sound effect must mark a specific beat and never sit on top of dialogue. Conversations get none
 * unless an audio peak lands in a pause.
 */
export function pickSfxBeat(manifest: Pick<SourceTranscript, 'beats' | 'peaks' | 'cues'>,
  highlight: { startSec: number; endSec: number }) {
  const moments = manifest.peaks ?? manifest.beats ?? [];
  return moments.find(t => t > highlight.startSec + 0.5 && t < highlight.endSec - 0.5 &&
    !manifest.cues.some(cue => cue.startSec - 0.3 < t && cue.endSec + 0.3 > t));
}

function wordsOf(text: string) {
  return new Set(text.toLowerCase().match(WORD) ?? []);
}

/**
 * Pick self-contained moments across the whole recording. One slot per ten minutes (rounded up) is a
 * ceiling, never a quota: weak, overlapping and repeated moments are dropped.
 */
export function selectHighlights(manifest: SourceTranscript, score: (text: string) => number,
  limit = Math.ceil(manifest.durationSec / 600)): SelectedHighlight[] {
  const peaks = manifest.peaks ?? [];
  const label = (candidate: NonNullable<ReturnType<typeof selectHighlight>>): SelectedHighlight => ({
    ...candidate, contentType: classifySegment(manifest.cues, candidate.startSec, candidate.endSec, peaks),
  });
  // Search the full timeline. After each pick, search the remaining spans on either side of it.
  const regions: TimedSpeechCue[][] = manifest.cues.length ? [[...manifest.cues]] : [];
  const candidates: SelectedHighlight[] = selectActionMoments(manifest, score);
  const speechPicks = new Set<SelectedHighlight>();
  const addSpeech = (pick: ReturnType<typeof selectHighlight>) => {
    if (!pick) return;
    const labelled = label(pick);
    speechPicks.add(labelled);
    candidates.push(labelled);
  };
  if (regions[0]) addSpeech(selectHighlight(regions[0], score, manifest.beats, manifest.durationSec));

  const selected: SelectedHighlight[] = [];
  while (candidates.length && selected.length < limit) {
    candidates.sort((a, b) => b.rank - a.rank || a.startSec - b.startSec);
    const candidate = candidates.shift()!;
    const words = wordsOf(candidate.transcript);
    const overlapsTime = selected.some(other => candidate.startSec < other.endSec && other.startSec < candidate.endSec);
    const repeats = words.size > 0 && selected.some(other => {
      const unique = wordsOf(other.transcript);
      const shared = [...unique].filter(word => words.has(word)).length;
      return shared / Math.max(words.size, unique.size) > 0.75;
    });
    if (!overlapsTime && !repeats) selected.push(candidate);
    // Action windows come from audio peaks, not from a speech region, so they never split one.
    if (!speechPicks.has(candidate)) continue;

    const region = regions.find(part => part[0]!.startSec <= candidate.startSec && part.at(-1)!.endSec >= candidate.startSec);
    if (!region) continue;
    regions.splice(regions.indexOf(region), 1);
    for (const rest of [region.filter(cue => cue.endSec <= candidate.startSec), region.filter(cue => cue.startSec >= candidate.endSec)]) {
      if (!rest.length) continue;
      regions.push(rest);
      addSpeech(selectHighlight(rest, score, manifest.beats, manifest.durationSec));
    }
  }
  return selected.sort((a, b) => a.startSec - b.startSec).map(pick => padToPauses(pick, manifest.cues, manifest.durationSec));
}

export async function readTranscript(storage: S3StorageConfig, key: string) {
  const response = await fetch(createPresignedS3Url({ config: storage, method: 'GET', objectKey: key }), {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error('Source transcript unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 16 * 1024 * 1024) throw new Error('Source transcript exceeds 16 MiB');
    chunks.push(chunk);
  }
  return parseTranscript(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** Analyzes one recording: reads platform captions or audio, and writes transcript.json. */
export type RecordingAnalyzer = (request: AnalysisRequest, storage: S3StorageConfig, prefix: string) => Promise<AnalysisOutcome>;

/** Stable clip id from the source and the selected range, so a restart cannot create a second clip or charge. */
function stableClipId(sourceId: string, startSec: number, endSec: number) {
  const digest = createHash('sha256').update(JSON.stringify([sourceId, startSec, endSec])).digest();
  digest[6] = (digest[6]! & 15) | 0x80;
  digest[8] = (digest[8]! & 63) | 0x80;
  const hex = digest.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/** Lease for a running analysis. A heartbeat extends it, so a crashed worker's job is retried within this time. */
const ANALYSIS_LEASE_MS = 15 * 60_000;

/** Recordings waiting for analysis in one workspace, oldest first. */
export function readySources(prisma: PrismaClient, workspaceId: string, take = 8) {
  const now = new Date();
  return prisma.channelVideo.findMany({
    where: {
      workspaceId, clipJobId: null, detectionStatus: 'DETECTED',
      creator: { autoMonitorEnabled: true },
      OR: [{ nextAutomationAttemptAt: null }, { nextAutomationAttemptAt: { lte: now } }],
    },
    orderBy: [{ nextAutomationAttemptAt: { sort: 'asc', nulls: 'first' } }, { detectedAt: 'asc' }],
    take,
    select: { id: true },
  });
}

/**
 * Claim and analyze one recording, then create its clip jobs. Returns false when another worker holds it.
 * Analysis is bounded by the workspace plan: longest recording and recorded hours per billing period.
 */
export async function analyzeSource(prisma: PrismaClient, sourceId: string, storage: S3StorageConfig, analyzer?: RecordingAnalyzer) {
  const source = await prisma.channelVideo.findUnique({
    where: { id: sourceId },
    include: { creator: { include: { routes: { where: { enabled: true }, include: { socialAccount: true } } } } },
  });
  if (!source || source.clipJobId || source.detectionStatus !== 'DETECTED' || !source.creator.autoMonitorEnabled) return false;
  const workspaceId = source.workspaceId;
  const claimedAt = new Date();
  const where = { id: source.id, clipJobId: null, detectionStatus: 'DETECTED', nextAutomationAttemptAt: source.nextAutomationAttemptAt };
  const claimed = await prisma.channelVideo.updateMany({
    where: { ...where, OR: [{ nextAutomationAttemptAt: null }, { nextAutomationAttemptAt: { lte: claimedAt } }] },
    data: { nextAutomationAttemptAt: new Date(claimedAt.getTime() + ANALYSIS_LEASE_MS), analysisStartedAt: claimedAt },
  });
  if (!claimed.count) return false;
  const current = { id: source.id, clipJobId: null, detectionStatus: 'DETECTED', analysisStartedAt: claimedAt };
  const heartbeat = setInterval(() => {
    void prisma.channelVideo.updateMany({ where: current, data: { nextAutomationAttemptAt: new Date(Date.now() + ANALYSIS_LEASE_MS) } })
      .catch(() => undefined);
  }, ANALYSIS_LEASE_MS / 3);
  const release = (data: Record<string, unknown>) => prisma.channelVideo.updateMany({
    where: current, data: { analysisStartedAt: null, ...data },
  });
  const prefix = buildSourceBundlePrefix(workspaceId, source.creatorId, source.id);

  try {
    const creator = source.creator;
    const requiredTopics = JSON.parse(creator.requiredTopicsJson) as string[];
    const bannedKeywords = JSON.parse(creator.bannedKeywordsJson) as string[];
    const evaluate = (transcript: string, caption = '') => evaluateClipCompliance({
      transcript, caption, requiredTopics, bannedKeywords, disallowLogos: creator.disallowLogos, hasAddedLogos: false,
    });
    const score = (text: string) => {
      const compliance = evaluate(text);
      return compliance.passed ? compliance.score + 5 * compliance.matchedTopics.length : 0;
    };

    const transcriptKey = `${prefix}/transcript.json`;
    let manifest = await readTranscript(storage, transcriptKey);
    let shared = false;
    if (!manifest && analyzer && isCreatorPlatformUrl(creator.platform, source.videoUrl)) {
      const workspace = await ensureCurrentBillingPeriod(prisma, workspaceId);
      const plan = SAAS_PLANS[(workspace?.planTier ?? 'FREE') as PlanTier] ?? SAAS_PLANS.FREE;
      const remainingSec = plan.monthlyAnalysisHours * 3600 - (workspace?.analysisSecondsUsed ?? 0);
      if (remainingSec <= 0) {
        await release({ nextAutomationAttemptAt: new Date(Date.now() + 6 * 3600_000),
          automationError: `This plan's ${plan.monthlyAnalysisHours} hours of recording analysis are used up for this month.` });
        return true;
      }
      const maxRecordingSec = Math.min(plan.maxRecordingHours * 3600, remainingSec);
      const outcome = await sharedAnalysis(prisma, storage, analyzer, {
        platform: creator.platform, externalVideoId: source.externalVideoId, spokenLanguage: creator.spokenLanguage,
        videoUrl: source.videoUrl, title: source.title, maxRecordingSec,
      });
      if (outcome.status === 'BUSY') {
        await release({ nextAutomationAttemptAt: new Date(Date.now() + 2 * 60_000), automationError: 'Analysis in progress. The worker will check again shortly.' });
        return true;
      }
      if (outcome.status === 'NOT_READY') {
        await release({ nextAutomationAttemptAt: new Date(Date.now() + 10 * 60_000), automationError: outcome.reason });
        return true;
      }
      if (outcome.status === 'TOO_LONG') {
        const hours = (outcome.durationSec / 3600).toFixed(1);
        await release({
          detectionStatus: 'SKIPPED', durationSec: outcome.durationSec,
          automationError: outcome.durationSec > plan.maxRecordingHours * 3600
            ? `This ${hours}-hour recording is longer than the plan allows (${plan.maxRecordingHours} hours).`
            : `This ${hours}-hour recording exceeds the analysis hours left this month.`,
        });
        return true;
      }
      // Every workspace is charged the recorded time it uses, even when the analysis was shared.
      await prisma.$transaction([
        prisma.workspace.update({ where: { id: workspaceId }, data: { analysisSecondsUsed: { increment: outcome.manifest.durationSec } } }),
        prisma.channelVideo.updateMany({ where: current, data: { analysisCostJson: JSON.stringify({ ...outcome.cost, cacheHit: outcome.cacheHit }) } }),
      ]);
      manifest = outcome.manifest;
      shared = true;
    }
    if (!manifest) {
      await release({ nextAutomationAttemptAt: new Date(Date.now() + 10 * 60_000),
        automationError: 'Waiting for the recording and transcript. Check the source connection.' });
      return true;
    }
    // Uploaded or chunked media lives in storage; caption-first analysis renders straight from the platform.
    const sectionUrl = manifest.mediaUrl && isCreatorPlatformUrl(creator.platform, manifest.mediaUrl) ? manifest.mediaUrl : null;
    const sourceKey = manifest.chunkSeconds ? `${prefix}/chunks/0.mp4` : `${prefix}/source.mp4`;
    if (!sectionUrl) {
      const media = await fetch(createPresignedS3Url({ config: storage, method: 'HEAD', objectKey: sourceKey }), {
        method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      if (media.status === 404) throw new Error('Recording upload is missing');
      if (!media.ok) throw new Error('Source video unavailable');
      const size = Number(media.headers.get('content-length'));
      if (size <= 0 || size > MAX_SOURCE_BYTES) throw new Error('Invalid source video size');
    }

    const candidate = manifest.highlight;
    const selected: SelectedHighlight[] = candidate ? [{
      ...candidate, rank: 0,
      contentType: classifySegment(manifest.cues, candidate.startSec, candidate.endSec, manifest.peaks),
      transcript: manifest.cues.filter((cue) => cue.startSec >= candidate.startSec && cue.endSec <= candidate.endSec)
        .map((cue) => cue.text).join(' '),
      cues: manifest.cues.filter((cue) => cue.startSec >= candidate.startSec && cue.endSec <= candidate.endSec)
        .map((cue) => ({ ...cue, startSec: cue.startSec - candidate.startSec, endSec: cue.endSec - candidate.startSec })),
    }] : shared ? chooseForWorkspace(manifest, evaluate) : manifest.highlights ?? selectHighlights(manifest, score);
    const highlights = selected.filter(highlight => evaluate(highlight.transcript).passed);
    if (!highlights.length) {
      await release({ detectionStatus: 'SKIPPED', durationSec: manifest.durationSec });
      return true;
    }

    await ensureCurrentBillingPeriod(prisma, workspaceId);
    await prisma.$transaction(async (tx) => {
      const linked = await tx.channelVideo.updateMany({
        where: current, data: { detectionStatus: 'PROCESSING', durationSec: manifest.durationSec, automationError: null, analysisStartedAt: null },
      });
      if (!linked.count) return;
      let firstClipId: string | null = null;
      for (const highlight of highlights) {
        const clipId = stableClipId(source.id, highlight.startSec, highlight.endSec);
        const chunk = manifest.chunkSeconds ? Math.floor(highlight.startSec / manifest.chunkSeconds) : 0;
        // A moment that crosses a chunk boundary renders from the adjacent chunks joined together.
        const lastChunk = manifest.chunkSeconds ? Math.floor((highlight.endSec - 0.001) / manifest.chunkSeconds) : 0;
        // Section downloads start a second early so the first frame is never cut short.
        const offset = sectionUrl ? Math.max(0, Math.floor(highlight.startSec) - 1) : chunk * (manifest.chunkSeconds ?? 0);
        const compliance = evaluate(highlight.transcript);
        const captionStyle = creator.defaultCaptionStyle as CaptionStyleId;
        const tags = JSON.parse(creator.tagsJson) as string[];
        const beat = pickSfxBeat(manifest, highlight);
        const sfxCues = creator.enableSfx && beat !== undefined
          ? [{ preset: 'POP', atSec: beat - highlight.startSec, gainDb: -22 }] : [];
        const posts = creator.routes.flatMap((route) => {
          const hashtags = [...tags, ...(JSON.parse(route.hashtagsJson) as string[])].map((tag) =>
            tag.startsWith('#') ? tag : `#${tag.replace(/\s+/g, '')}`);
          const captionText = route.captionTemplate.replace('{hook}', source.title).replace('{tags}', hashtags.join(' ')).trim();
          const report = evaluate(highlight.transcript, captionText);
          if (!report.passed || report.score < route.minComplianceScore) return [];
          return [{
            workspaceId, socialAccountId: route.socialAccountId, platform: route.socialAccount.platform,
            idempotencyKey: `clip-${clipId}-acct-${route.socialAccountId}`,
            captionText, status: 'AWAITING_APPROVAL', executionMode: route.socialAccount.integrationMode,
          }];
        });

        const reserved = await tx.workspace.updateMany({
          where: { id: workspaceId, clipsUsedThisPeriod: { lt: tx.workspace.fields.monthlyClipLimit } },
          data: { clipsUsedThisPeriod: { increment: 1 } },
        });
        if (!reserved.count) break;
        firstClipId ??= clipId;
        await tx.clipJob.create({
          data: {
            id: clipId, workspaceId, creatorId: creator.id, sourceUrl: source.videoUrl,
            title: source.title, startSec: highlight.startSec, endSec: highlight.endSec,
            durationSec: highlight.endSec - highlight.startSec, transcript: highlight.transcript,
            layout: creator.defaultLayout, captionStyle, enableSfx: creator.enableSfx, sfxCuesJson: JSON.stringify(sfxCues),
            assScript: buildWordSyncedAss(highlight.cues, captionStyle), sourceVideoId: source.id, sourceOffsetSec: offset,
            sourceChunkCount: sectionUrl ? 1 : lastChunk - chunk + 1, contentType: highlight.contentType,
            speakerTurnsJson: JSON.stringify(speakerTurns(highlight.cues)),
            // Marks an automatic clip; for section renders the media comes from sourceSectionUrl instead.
            automationSourceKey: sectionUrl ? `${prefix}/section` : manifest.chunkSeconds ? `${prefix}/chunks/${chunk}.mp4` : sourceKey,
            sourceSectionUrl: sectionUrl,
            executionStatus: 'QUEUED', compliancePassed: true, complianceScore: compliance.score,
            complianceReportJson: JSON.stringify(compliance),
            publishPosts: { create: posts },
          },
        });
      }
      await tx.channelVideo.update({ where: { id: source.id }, data: { clipJobId: firstClipId, detectionStatus: firstClipId ? 'PROCESSING' : 'DETECTED' } });
    });
    return true;
  } catch (error) {
    // A configuration problem will not fix itself on retry, so say exactly what to change.
    const message = error instanceof Error && error.message.includes('English-only whisper model')
      ? error.message : 'Recording analysis could not finish. The worker will retry.';
    await release({ nextAutomationAttemptAt: new Date(Date.now() + 10 * 60_000), automationError: message });
    console.error('Source automation deferred', source.id, error instanceof Error ? error.name : 'UnknownError');
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Generic quality for shared analyses: no workspace's rules may shape what every workspace can see. */
const SHARED_SCORE = () => 50;
/** Shared analyses keep this many candidates per clip slot so each workspace can choose under its own rules. */
const SHARED_CANDIDATE_POOL = 3;

export type SharedAnalysisResult =
  | { status: 'READY'; manifest: SourceTranscript; cost: Record<string, unknown>; cacheHit: boolean }
  | { status: 'BUSY' }
  | { status: 'NOT_READY'; reason: string }
  | { status: 'TOO_LONG'; durationSec: number };

/** Storage prefix for one public recording's shared analysis. IDs are platform video IDs (letters, digits, - _). */
export function sharedRecordingPrefix(platform: string, externalVideoId: string, spokenLanguage: string) {
  const safe = (value: string) => value.replace(/[^\w-]/g, '_').slice(0, 80);
  return `shared/recordings/${safe(platform.toLowerCase())}/${safe(externalVideoId)}/${safe(spokenLanguage)}`;
}

/**
 * Analyze a public recording once for every workspace that tracks it. A finished analysis is reused;
 * one in progress elsewhere returns BUSY; otherwise this worker claims the row (a lease kept alive by a
 * heartbeat) and runs the analyzer without any workspace's rules.
 */
export async function sharedAnalysis(prisma: PrismaClient, storage: S3StorageConfig, analyzer: RecordingAnalyzer, request: {
  platform: string; externalVideoId: string; spokenLanguage: string; videoUrl: string; title: string; maxRecordingSec: number;
}): Promise<SharedAnalysisResult> {
  const key = { platform: request.platform, externalVideoId: request.externalVideoId, spokenLanguage: request.spokenLanguage };
  const prefix = sharedRecordingPrefix(request.platform, request.externalVideoId, request.spokenLanguage);
  const manifestKey = `${prefix}/transcript.json`;
  const existing = await prisma.recordingAnalysis.findUnique({ where: { platform_externalVideoId_spokenLanguage: key } });
  if (existing?.status === 'READY') {
    if (existing.durationSec > request.maxRecordingSec) return { status: 'TOO_LONG', durationSec: existing.durationSec };
    const manifest = await readTranscript(storage, existing.manifestKey ?? manifestKey);
    if (manifest) return { status: 'READY', manifest, cost: JSON.parse(existing.costJson) as Record<string, unknown>, cacheHit: true };
    // The stored analysis is gone (for example a lifecycle rule removed it): analyze again.
  }

  const leaseUntil = () => new Date(Date.now() + ANALYSIS_LEASE_MS);
  let rowId: string;
  if (!existing) {
    try {
      rowId = (await prisma.recordingAnalysis.create({ data: { ...key, status: 'RUNNING', leaseUntil: leaseUntil() } })).id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { status: 'BUSY' };
      throw error;
    }
  } else {
    const claimed = await prisma.recordingAnalysis.updateMany({
      where: { id: existing.id, OR: [{ status: { not: 'RUNNING' } }, { leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
      data: { status: 'RUNNING', leaseUntil: leaseUntil() },
    });
    if (!claimed.count) return { status: 'BUSY' };
    rowId = existing.id;
  }

  const heartbeat = setInterval(() => {
    void prisma.recordingAnalysis.updateMany({ where: { id: rowId, status: 'RUNNING' }, data: { leaseUntil: leaseUntil() } }).catch(() => undefined);
  }, ANALYSIS_LEASE_MS / 3);
  const settle = (data: Prisma.RecordingAnalysisUpdateManyMutationInput) =>
    prisma.recordingAnalysis.updateMany({ where: { id: rowId }, data: { leaseUntil: null, ...data } });
  try {
    const outcome = await analyzer({
      platform: request.platform, videoUrl: request.videoUrl, title: request.title, spokenLanguage: request.spokenLanguage,
      score: SHARED_SCORE, requiredTopics: [], bannedKeywords: [], maxRecordingSec: request.maxRecordingSec,
      candidatePool: SHARED_CANDIDATE_POOL,
    }, storage, prefix);
    if (outcome.status === 'NOT_READY') {
      await settle({ status: 'PENDING' });
      return outcome;
    }
    if (outcome.status === 'TOO_LONG') {
      // Too long for this workspace's plan; another workspace with a larger plan may still claim it.
      await settle({ status: 'PENDING', durationSec: outcome.durationSec });
      return outcome;
    }
    const manifest = await readTranscript(storage, manifestKey);
    if (!manifest) throw new Error('Shared analysis output is missing');
    await settle({ status: 'READY', manifestKey, durationSec: outcome.cost.recordingSec, costJson: JSON.stringify(outcome.cost) });
    return { status: 'READY', manifest, cost: { ...outcome.cost }, cacheHit: false };
  } catch (error) {
    await settle({ status: 'FAILED' }).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Choose one workspace's clips from a shared analysis, in memory: shared candidates that pass this
 * workspace's compliance rules, boosted by its campaign topics; then, if slots remain, the rule-based
 * scan of the shared transcript with this workspace's own scoring. At most one clip per ten minutes.
 */
export function chooseForWorkspace(manifest: SourceTranscript, evaluate: (transcript: string) => { passed: boolean; score: number; matchedTopics: readonly string[] }) {
  const limit = Math.ceil(manifest.durationSec / 600);
  const score = (text: string) => {
    const report = evaluate(text);
    return report.passed ? report.score + 5 * report.matchedTopics.length : 0;
  };
  const pool = (manifest.highlights ?? []).flatMap(highlight => {
    const report = evaluate(highlight.transcript);
    return report.passed ? [{ ...highlight, rank: highlight.rank + 5 * report.matchedTopics.length + report.score / 10 }] : [];
  }).sort((a, b) => b.rank - a.rank);
  const fallback = pool.length >= limit ? [] : selectHighlights(manifest, score);
  const kept: SelectedHighlight[] = [];
  for (const candidate of [...pool, ...fallback]) {
    if (kept.length >= limit) break;
    if (kept.some(other => candidate.startSec < other.endSec && other.startSec < candidate.endSec)) continue;
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.startSec - b.startSec);
}

/** Automatic clips waiting to render (or whose render lease expired) in one workspace. */
export function readyClips(prisma: PrismaClient, workspaceId: string, take = 4) {
  return prisma.clipJob.findMany({
    where: {
      workspaceId, automationSourceKey: { not: null }, creator: { autoMonitorEnabled: true },
      OR: [{ executionStatus: 'QUEUED' }, { executionStatus: 'RUNNING', updatedAt: { lt: new Date(Date.now() - RENDER_LEASE_MS) } }],
    },
    orderBy: { createdAt: 'asc' }, take,
  });
}

/** Rendered automatic clips whose destinations accept automatic posting, oldest first. */
export async function readyPosts(prisma: PrismaClient, workspaceId: string, take = 10) {
  if (!await autoPublishAllowed(prisma, workspaceId)) return [];
  return prisma.publishPost.findMany({
    where: {
      workspaceId, status: 'AWAITING_APPROVAL', socialAccount: { autoPublishApproved: true },
      clipJob: {
        automationSourceKey: { not: null }, executionStatus: 'COMPLETED', compliancePassed: true,
        approvalStatus: { in: ['AWAITING_APPROVAL', 'APPROVED'] }, creator: { autoMonitorEnabled: true },
      },
    },
    orderBy: { createdAt: 'asc' }, take,
    select: { id: true },
  });
}

/**
 * Run every kind of automatic work for one workspace in sequence. The worker pool calls the task
 * functions above directly; this remains for single-process use and tests.
 */
export async function processWorkspaceSources(
  prisma: PrismaClient,
  workspaceId: string,
  storage: S3StorageConfig,
  analyzer?: RecordingAnalyzer,
) {
  let analyzed = false;
  for (const { id } of await readySources(prisma, workspaceId)) {
    // Analysis is the expensive step: one recording per pass, so other workspaces get their turn.
    const source = await prisma.channelVideo.findUnique({ where: { id }, select: { videoUrl: true, creator: { select: { platform: true } } } });
    const needsAnalyzer = !!analyzer && !!source && isCreatorPlatformUrl(source.creator.platform, source.videoUrl);
    if (needsAnalyzer && analyzed) continue;
    if (await analyzeSource(prisma, id, storage, analyzer) && needsAnalyzer) analyzed = true;
  }
  for (const clip of await readyClips(prisma, workspaceId)) await renderStoredClip(prisma, clip, storage);
  for (const post of await readyPosts(prisma, workspaceId)) await publishClipPost(prisma, post.id, workspaceId);
}
