import { describe, expect, it } from 'vitest';
import { assertSafeExternalUrl } from '../auth.js';
import { validatePostForPlatform } from '../integrations/publishing.js';
import { buildTenantClipObjectKey, createPresignedS3Url } from '../integrations/storage.js';
import { renderBrandedEmail } from '../integrations/email.js';
import { parseYouTubeAtomLatestVideo } from '../integrations/scheduler.js';
import { getUtcBillingMonthStart, isBillingPeriodExpired } from '../billing-period.js';
import { placeSpeechPhrase, readSpeechIntervals } from '../services/speech-timing.js';

describe('Production Security & External Integration Adapters', () => {
  it('ends a caption with its spoken words when the next phrase follows a long pause', () => {
    const intervals = readSpeechIntervals([
      'Final speech segments after filtering: 2',
      'VAD segment 0: start = 0.00, end = 1.66',
      'VAD segment 1: start = 3.55, end = 5.50',
    ].join('\n'));
    const phrase = { text: 'right here.', offsets: { from: 100, to: 2200 } };
    expect(placeSpeechPhrase(phrase, intervals[1]!)).toEqual({ start: 3650, end: 5500, text: 'right here.' });
    expect(() => readSpeechIntervals('Final speech segments after filtering: 1')).toThrow();
  });

  it('1. SSRF guard blocks loopback, private CIDR, cloud metadata & non-HTTP schemes', () => {
    expect(assertSafeExternalUrl('http://127.0.0.1:4100/api/health').safe).toBe(false);
    expect(assertSafeExternalUrl('http://localhost:3100').safe).toBe(false);
    expect(assertSafeExternalUrl('http://169.254.169.254/latest/meta-data/').safe).toBe(false);
    expect(assertSafeExternalUrl('http://10.0.0.4/internal').safe).toBe(false);
    expect(assertSafeExternalUrl('http://192.168.1.1/admin').safe).toBe(false);
    expect(assertSafeExternalUrl('file:///etc/passwd').safe).toBe(false);

    expect(assertSafeExternalUrl('https://www.twitch.tv/lacy').safe).toBe(true);
    expect(assertSafeExternalUrl('https://www.youtube.com/watch?v=-YWR0zFho6M').safe).toBe(true);
  });

  it('2. Platform publishing validator enforces platform-specific duration & caption limits', () => {
    const validShorts = validatePostForPlatform({
      platform: 'YOUTUBE_SHORTS',
      durationSec: 45,
      captionText: 'GTA 6 Marathon Highlight #shorts',
    });
    expect(validShorts.valid).toBe(true);

    const tooLongShorts = validatePostForPlatform({
      platform: 'YOUTUBE_SHORTS',
      durationSec: 75,
      captionText: 'Too long for Shorts',
    });
    expect(tooLongShorts.valid).toBe(false);

    const tooLongXCaption = validatePostForPlatform({
      platform: 'X',
      durationSec: 30,
      captionText: 'a'.repeat(300),
    });
    expect(tooLongXCaption.valid).toBe(false);
  });

  it('3. S3 SigV4 presigned URL generator creates tenant-isolated signed URLs', () => {
    const key = buildTenantClipObjectKey('ws-123', 'clip-456', 'mp4');
    expect(key).toBe('workspaces/ws-123/clips/clip-456.mp4');

    const url = createPresignedS3Url({
      config: {
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        bucket: 'clip-network-media',
        region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      method: 'GET',
      objectKey: key,
      expiresSec: 900,
    });
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('/clip-network-media/workspaces/ws-123/clips/clip-456.mp4');
  });

  it('4. Branded transactional email templates render responsive HTML & plain-text fallback', () => {
    const email = renderBrandedEmail('VERIFY_EMAIL', {
      recipientName: 'Alex',
      actionUrl: 'https://app.clipnetwork.io/verify-email?token=abc',
    });
    expect(email.subject).toContain('Verify your Clip Network');
    expect(email.html).toContain('CLIP NETWORK');
    expect(email.html).toContain('https://app.clipnetwork.io/verify-email?token=abc');
    expect(email.text).toContain('Verify your Clip Network email address');
  });

  it('5. YouTube Atom RSS parser extracts latest uploaded video metadata', () => {
    const sampleXml = `
      <feed>
        <entry>
          <yt:videoId>dQw4w9WgXcQ</yt:videoId>
          <title>Latest Creator Stream Highlight</title>
          <published>2026-11-22T10:00:00Z</published>
        </entry>
      </feed>
    `;
    const parsed = parseYouTubeAtomLatestVideo(sampleXml);
    expect(parsed).not.toBeNull();
    expect(parsed?.externalVideoId).toBe('dQw4w9WgXcQ');
    expect(parsed?.title).toBe('Latest Creator Stream Highlight');
    expect(parsed?.videoUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('6. UTC monthly billing period rollover detects expired periods cleanly without timezone drift', () => {
    const novMid = new Date('2026-11-22T12:00:00Z');
    const novStart = getUtcBillingMonthStart(novMid);
    expect(novStart.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(isBillingPeriodExpired(new Date('2026-10-31T23:59:59Z'), novMid)).toBe(true);
    expect(isBillingPeriodExpired(new Date('2026-11-01T00:00:00Z'), novMid)).toBe(false);
    expect(isBillingPeriodExpired(new Date('2026-11-15T10:00:00Z'), novMid)).toBe(false);
  });
});
