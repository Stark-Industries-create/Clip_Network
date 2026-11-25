import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { timedWords, type TimedWord } from '@clip-network/clip-engine';

/**
 * A hosted Whisper service with the OpenAI-compatible `POST /audio/transcriptions` API, for example
 * Groq (`https://api.groq.com/openai/v1`, model `whisper-large-v3-turbo`) or OpenAI. Hosted inference
 * turns hours of CPU transcription into minutes for streams without platform captions.
 */
export interface HostedTranscriptionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function getHostedTranscriptionConfig(env: NodeJS.ProcessEnv = process.env): HostedTranscriptionConfig | null {
  const baseUrl = env['TRANSCRIPTION_API_URL']?.trim();
  const apiKey = env['TRANSCRIPTION_API_KEY']?.trim();
  if (!baseUrl && !apiKey) return null;
  if (!baseUrl || !apiKey) throw new Error('Hosted transcription needs TRANSCRIPTION_API_URL and TRANSCRIPTION_API_KEY');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('TRANSCRIPTION_API_URL must be an HTTPS endpoint');
  return { baseUrl: url.href.replace(/\/$/, ''), apiKey, model: env['TRANSCRIPTION_MODEL']?.trim() || 'whisper-large-v3-turbo' };
}

interface VerboseTranscription {
  words?: { word?: string; start?: number; end?: number }[];
  segments?: { start?: number; end?: number; text?: string }[];
}

/**
 * Word timings from a verbose_json response. Providers that only return segments get their segment
 * time shared across its words by length.
 */
export function parseVerboseTranscription(body: VerboseTranscription, durationSec: number): TimedWord[] {
  const clamp = (t: number) => Math.min(durationSec, Math.max(0, t));
  const words = (body.words ?? []).flatMap(word => {
    const text = (word.word ?? '').trim();
    if (!text || !Number.isFinite(word.start) || !Number.isFinite(word.end)) return [];
    const startSec = clamp(word.start!);
    return [{ startSec, endSec: Math.max(startSec + 0.05, clamp(word.end!)), text }];
  });
  if (words.length) return words;
  return (body.segments ?? []).flatMap(segment => {
    const text = (segment.text ?? '').trim();
    if (!text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end! <= segment.start!) return [];
    return timedWords({ startSec: clamp(segment.start!), endSec: clamp(segment.end!), text });
  });
}

/**
 * Transcribe one audio file (keep it well under the provider's upload limit; ten minutes of mono 32 kbps
 * audio is about 2.4 MB). Rate limits and server errors are retried with backoff.
 */
export async function transcribeWithApi(config: HostedTranscriptionConfig, filePath: string, durationSec: number,
  spokenLanguage = 'auto', signal?: AbortSignal): Promise<TimedWord[]> {
  const audio = new Blob([new Uint8Array(await readFile(filePath))], { type: 'audio/mp4' });
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('file', audio, basename(filePath));
    form.append('model', config.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    form.append('temperature', '0');
    if (spokenLanguage !== 'auto') form.append('language', spokenLanguage);
    const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
    if (response.ok) return parseVerboseTranscription(await response.json() as VerboseTranscription, durationSec);
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt));
      continue;
    }
    // Never echo the response body: it can contain request details.
    throw new Error(`Hosted transcription failed (${response.status})`);
  }
}
