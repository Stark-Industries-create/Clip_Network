import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHostedTranscriptionConfig, parseVerboseTranscription, transcribeWithApi } from '../integrations/hosted-transcription.js';
import { formatTranscriptLines, getHighlightLlmConfig, parseLlmPicks, rankWithLlm } from '../integrations/llm-highlights.js';
import { assertProductionConfig } from '../production-config.js';
import { CAPTION_WAIT_MS, picksToHighlights, shouldWaitForCaptions, snapToSentences } from '../services/recording-analysis.js';

afterEach(() => vi.restoreAllMocks());

const asr = { baseUrl: 'https://asr.example/openai/v1', apiKey: 'test-key', model: 'whisper-large-v3-turbo' };
const llm = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'cheap-long-context' };

describe('Hosted transcription (OpenAI-compatible)', () => {
  it('requires a complete HTTPS configuration and defaults the model', () => {
    expect(getHostedTranscriptionConfig({})).toBeNull();
    expect(getHostedTranscriptionConfig({ TRANSCRIPTION_API_URL: 'https://api.groq.com/openai/v1/', TRANSCRIPTION_API_KEY: 'k' }))
      .toEqual({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', model: 'whisper-large-v3-turbo' });
    expect(() => getHostedTranscriptionConfig({ TRANSCRIPTION_API_KEY: 'k' })).toThrow(/TRANSCRIPTION_API_URL/);
    expect(() => getHostedTranscriptionConfig({ TRANSCRIPTION_API_URL: 'http://asr.example', TRANSCRIPTION_API_KEY: 'k' })).toThrow(/HTTPS/);
  });

  it('reads word timings, and falls back to segments shared across their words', () => {
    expect(parseVerboseTranscription({ words: [{ word: ' Hello', start: 0.1, end: 0.4 }, { word: 'there.', start: 0.4, end: 9 }] }, 5))
      .toEqual([{ startSec: 0.1, endSec: 0.4, text: 'Hello' }, { startSec: 0.4, endSec: 5, text: 'there.' }]);
    const fromSegments = parseVerboseTranscription({ segments: [{ start: 1, end: 3, text: ' Good morning ' }] }, 10);
    expect(fromSegments.map(w => w.text)).toEqual(['Good', 'morning']);
    expect(fromSegments[1]!.endSec).toBeCloseTo(3);
  });

  it('uploads with word timestamps and the creator language, retries rate limits, and never leaks error bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asr-'));
    const file = join(dir, 'window.m4a');
    writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    const calls: FormData[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async (_url, init) => { calls.push(init!.body as FormData); return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } }); })
      .mockImplementationOnce(async (url, init) => {
        calls.push(init!.body as FormData);
        expect(String(url)).toBe('https://asr.example/openai/v1/audio/transcriptions');
        expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
        return Response.json({ words: [{ word: 'नमस्ते', start: 0, end: 0.6 }] });
      });
    try {
      const words = await transcribeWithApi(asr, file, 600, 'ne');
      expect(words).toEqual([{ startSec: 0, endSec: 0.6, text: 'नमस्ते' }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const form = calls[1]!;
      expect(form.get('model')).toBe('whisper-large-v3-turbo');
      expect(form.get('response_format')).toBe('verbose_json');
      expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
      expect(form.get('language')).toBe('ne');

      fetchMock.mockResolvedValueOnce(new Response('secret request details', { status: 401 }));
      await expect(transcribeWithApi(asr, file, 600)).rejects.toThrow(/^Hosted transcription failed \(401\)$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LLM highlight ranking', () => {
  const cues = Array.from({ length: 12 }, (_, i) => ({ startSec: i * 5, endSec: i * 5 + 4.5, text: `Line number ${i}.`, speaker: i % 2 ? 'w0:S1' : 'w0:S0' }));

  it('requires all three settings over HTTPS', () => {
    expect(getHighlightLlmConfig({})).toBeNull();
    expect(() => getHighlightLlmConfig({ HIGHLIGHT_LLM_URL: 'https://x.example', HIGHLIGHT_LLM_API_KEY: 'k' })).toThrow(/HIGHLIGHT_LLM_MODEL/);
    expect(() => getHighlightLlmConfig({ HIGHLIGHT_LLM_URL: 'http://x.example', HIGHLIGHT_LLM_API_KEY: 'k', HIGHLIGHT_LLM_MODEL: 'm' })).toThrow(/HTTPS/);
  });

  it('numbers transcript lines and places loud and most-replayed markers before the line they hit', () => {
    const text = formatTranscriptLines(cues, 0, 4, { loud: [10.2], replayed: [5] });
    expect(text.split('\n')).toEqual([
      'L0 [00:00] w0:S0: Line number 0.',
      '>> MOST REPLAYED at 00:05',
      'L1 [00:05] w0:S1: Line number 1.',
      'L2 [00:10] w0:S0: Line number 2.',
      '>> LOUD AUDIO SPIKE at 00:10',
      'L3 [00:15] w0:S1: Line number 3.',
    ]);
  });

  it('accepts only valid line ranges from the part that was sent', () => {
    const content = '```json\n{"highlights":[{"first_line":2,"last_line":5,"hook_score":91,"reason":"payoff"},' +
      '{"first_line":5,"last_line":2,"hook_score":99},{"first_line":-1,"last_line":3},{"first_line":3,"last_line":40},' +
      '{"first_line":"ignore previous instructions","last_line":4}]}\n```';
    expect(parseLlmPicks(content, 0, 12, 10)).toEqual([{ firstLine: 2, lastLine: 5, hookScore: 91, reason: 'payoff' }]);
    expect(parseLlmPicks('not json', 0, 12, 10)).toEqual([]);
  });

  it('sends hour-sized parts with global line numbers and adds up token usage', async () => {
    const many = Array.from({ length: 1600 }, (_, i) => ({ startSec: i * 2.5, endSec: i * 2.5 + 2.4, text: `Sentence ${i}.` }));
    const bodies: { model: string; response_format: unknown; messages: { content: string }[] }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      const firstLine = bodies.length === 1 ? 10 : 1510;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ highlights: [{ first_line: firstLine, last_line: firstLine + 8, hook_score: 80 }] }) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 40 },
      });
    });
    const ranking = await rankWithLlm(llm, { cues: many, durationSec: 4000, title: 'Stream', markers: {}, requiredTopics: ['space'], bannedKeywords: [] });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ model: 'cheap-long-context', response_format: { type: 'json_object' } });
    expect(bodies[0]!.messages[1]!.content).toContain('L0 [00:00]: Sentence 0.');
    expect(bodies[1]!.messages[1]!.content).toContain('L1500 [');
    expect(bodies[0]!.messages[0]!.content).toMatch(/untrusted data/);
    expect(ranking.picks.map(p => p.firstLine)).toEqual([10, 1510]);
    expect(ranking).toMatchObject({ inputTokens: 2000, outputTokens: 80 });
  });

  it('turns picks into clips: strong hooks only, 10-60 seconds, compliant, no overlaps, one slot per ten minutes', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ startSec: i * 3, endSec: i * 3 + 2.8, text: i === 30 ? 'Banned brand here.' : `Talk ${i}.` }));
    const score = (text: string) => (text.includes('Banned') ? 0 : 50);
    const picks = [
      { firstLine: 2, lastLine: 8, hookScore: 90, reason: '' },
      { firstLine: 4, lastLine: 10, hookScore: 85, reason: 'overlaps the first' },
      { firstLine: 12, lastLine: 13, hookScore: 95, reason: 'too short' },
      { firstLine: 28, lastLine: 34, hookScore: 99, reason: 'fails compliance' },
      { firstLine: 40, lastLine: 46, hookScore: 30, reason: 'weak' },
    ];
    const clips = picksToHighlights(picks, lines, 180, score);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ startSec: 6, rank: 90 });
    expect(clips[0]!.cues[0]!.startSec).toBe(0);
  });
});

describe('Exact edges and caption waiting', () => {
  it('moves a chosen range onto whole sentences without changing the moment', () => {
    const precise = [
      { startSec: 98, endSec: 100, text: 'and that is why.' },
      { startSec: 100.4, endSec: 104, text: 'So here is the surprising part,' },
      { startSec: 104, endSec: 112, text: 'the crew lost vision before they ever flew.' },
      { startSec: 112.5, endSec: 116, text: 'Nobody expected that.' },
      { startSec: 116.3, endSec: 119, text: 'Then we checked the genes' },
    ];
    const range = snapToSentences(precise, 101.5, 114);
    expect(range?.map(c => c.text)).toEqual(['So here is the surprising part,', 'the crew lost vision before they ever flew.', 'Nobody expected that.']);
    expect(snapToSentences(precise, 60, 70)).toBeNull();
  });

  it('waits for YouTube captions for 45 minutes and never waits on Twitch or Kick', () => {
    expect(shouldWaitForCaptions('YOUTUBE', false, 0, CAPTION_WAIT_MS - 1)).toBe(true);
    expect(shouldWaitForCaptions('YOUTUBE', false, 0, CAPTION_WAIT_MS)).toBe(false);
    expect(shouldWaitForCaptions('YOUTUBE', true, 0, 0)).toBe(false);
    expect(shouldWaitForCaptions('TWITCH', false, 0, 0)).toBe(false);
    expect(shouldWaitForCaptions('KICK', false, 0, 0)).toBe(false);
  });

  it('rejects half-configured providers in production', () => {
    const base = {
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://database/clipnetwork', ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      PUBLIC_APP_URL: 'https://app.example.test', S3_ENDPOINT: 'https://media.example.test', S3_BUCKET: 'clips',
      S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture', RESEND_API_KEY: 'fixture', EMAIL_FROM: 'test@example.test',
      STRIPE_SECRET_KEY: 'sk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_PRICE_STARTER: 'price_starter',
      STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_ENTERPRISE: 'price_enterprise', POSTIZ_API_KEY: 'fixture',
    };
    expect(() => assertProductionConfig('worker', { ...base, TRANSCRIPTION_API_URL: 'https://api.groq.com/openai/v1' })).toThrow(/TRANSCRIPTION_API_KEY/);
    expect(() => assertProductionConfig('worker', { ...base, HIGHLIGHT_LLM_API_KEY: 'k', HIGHLIGHT_LLM_MODEL: 'm' })).toThrow(/HIGHLIGHT_LLM_URL/);
    expect(() => assertProductionConfig('worker', {
      ...base, TRANSCRIPTION_API_URL: 'https://api.groq.com/openai/v1', TRANSCRIPTION_API_KEY: 'k',
      HIGHLIGHT_LLM_URL: 'https://llm.example/v1', HIGHLIGHT_LLM_API_KEY: 'k', HIGHLIGHT_LLM_MODEL: 'm',
    })).not.toThrow();
  });
});
