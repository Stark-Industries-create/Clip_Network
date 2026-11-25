import { randomUUID } from 'node:crypto';
import { decryptSecret } from '@clip-network/shared/crypto';

export interface PlatformLimits {
  maxDurationSec: number;
  maxCaptionLength: number;
  requiresVertical: boolean;
}

export const PLATFORM_PUBLISHING_LIMITS: Record<string, PlatformLimits> = {
  FACEBOOK_REELS: { maxDurationSec: 90, maxCaptionLength: 2200, requiresVertical: true },
  INSTAGRAM_REELS: { maxDurationSec: 90, maxCaptionLength: 2200, requiresVertical: true },
  TIKTOK: { maxDurationSec: 600, maxCaptionLength: 2200, requiresVertical: true },
  YOUTUBE_SHORTS: { maxDurationSec: 60, maxCaptionLength: 500, requiresVertical: true },
  X: { maxDurationSec: 140, maxCaptionLength: 280, requiresVertical: false },
};

export function validatePostForPlatform(params: {
  platform: string;
  durationSec: number;
  captionText: string;
}): { valid: boolean; errors: string[] } {
  const limits = PLATFORM_PUBLISHING_LIMITS[params.platform];
  if (!limits) {
    return { valid: false, errors: [`Unsupported social platform: ${params.platform}`] };
  }
  const errors: string[] = [];
  if (params.platform === 'FACEBOOK_REELS' && params.durationSec < 3) errors.push('Facebook Reels must be at least 3 seconds.');
  if (params.durationSec > limits.maxDurationSec) {
    errors.push(
      `${params.platform} supports clips up to ${limits.maxDurationSec}s (got ${params.durationSec}s).`,
    );
  }
  if (params.captionText.length > limits.maxCaptionLength) {
    errors.push(
      `${params.platform} captions must be <= ${limits.maxCaptionLength} characters.`,
    );
  }
  return { valid: errors.length === 0, errors };
}

export interface PublishDispatchResult {
  success: boolean;
  status: 'SUBMITTED' | 'PUBLISHED_SANDBOX' | 'FAILED';
  executionMode: 'LIVE_OAUTH' | 'SANDBOX_SIMULATED';
  externalPostId?: string;
  errorMessage?: string;
  needsReconciliation?: boolean;
}

function postizSettings(platform: string, caption: string) {
  switch (platform) {
    case 'INSTAGRAM_REELS':
      return { __type: 'instagram', post_type: 'post' };
    case 'X':
      return { __type: 'x', who_can_reply_post: 'everyone' };
    case 'YOUTUBE_SHORTS': {
      const audience = process.env['POSTIZ_YOUTUBE_MADE_FOR_KIDS'];
      if (audience !== 'yes' && audience !== 'no') return null;
      return {
        __type: 'youtube', title: caption.trim().slice(0, 100).padEnd(2, '.'), type: 'unlisted',
        selfDeclaredMadeForKids: audience, tags: [],
      };
    }
    default:
      return null;
  }
}

export async function dispatchSocialPublish(params: {
  platform: string;
  accountHandle: string;
  encryptedToken: string | null;
  captionText: string;
  idempotencyKey: string;
  mediaUrl?: string | null;
  durationSec: number;
}): Promise<PublishDispatchResult> {
  const validation = validatePostForPlatform({
    platform: params.platform,
    durationSec: params.durationSec,
    captionText: params.captionText,
  });
  if (!validation.valid) {
    return {
      success: false,
      status: 'FAILED',
      executionMode: 'SANDBOX_SIMULATED',
      errorMessage: validation.errors.join(' '),
    };
  }

  const postizKey = process.env['POSTIZ_API_KEY']?.trim();
  const postizBase =
    process.env['POSTIZ_API_BASE_URL']?.trim() || 'https://api.postiz.com/public/v1';

  if (postizKey && postizKey.length > 8 && params.encryptedToken) {
    try {
      const credential = decryptSecret(params.encryptedToken);
      const standalone = params.platform === 'INSTAGRAM_REELS' && credential.startsWith('instagram-standalone:');
      const settings = standalone ? { __type: 'instagram-standalone', post_type: 'post' } : postizSettings(params.platform, params.captionText);
      if (!settings) {
        return {
          success: false, status: 'FAILED', executionMode: 'LIVE_OAUTH',
          errorMessage: 'This destination needs platform-specific publishing settings before it can post.',
        };
      }
      const decryptedIntegrationId = standalone ? credential.slice('instagram-standalone:'.length) : credential;
      if (!params.mediaUrl) {
        return { success: false, status: 'FAILED', executionMode: 'LIVE_OAUTH', errorMessage: 'Missing rendered media.' };
      }
      const assetResponse = await fetch(`${postizBase}/upload-from-url`, {
        method: 'POST',
        headers: { Authorization: postizKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: params.mediaUrl }),
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      const asset = assetResponse.ok ? await assetResponse.json().catch(() => null) as { id?: string; path?: string } | null : null;
      if (!asset?.id || !asset.path) {
        return { success: false, status: 'FAILED', executionMode: 'LIVE_OAUTH', errorMessage: 'Postiz media import failed.' };
      }
      const res = await fetch(`${postizBase}/posts`, {
        method: 'POST',
        redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: postizKey,
          'Content-Type': 'application/json',
          'Idempotency-Key': params.idempotencyKey,
        },
        body: JSON.stringify({
          type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
          posts: [
            {
              integration: { id: decryptedIntegrationId },
              settings,
              value: [
                {
                  content: params.captionText,
                  image: [{ id: asset.id, path: asset.path }],
                },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        return {
          success: false,
          status: 'FAILED',
          executionMode: 'LIVE_OAUTH',
          errorMessage: `Postiz publish rejected (${res.status}): ${errText.slice(0, 180)}`,
          needsReconciliation: res.status >= 500,
        };
      }

      const body = (await res.json().catch(() => null)) as { id?: string; postId?: string } | { postId?: string }[] | null;
      const externalPostId = Array.isArray(body) ? body[0]?.postId : body?.postId ?? body?.id;
      if (!externalPostId) {
        return {
          success: false, status: 'FAILED', executionMode: 'LIVE_OAUTH', needsReconciliation: true,
          errorMessage: 'Provider response did not identify the post. Verify its status before retrying.',
        };
      }
      return {
        success: true,
        status: 'SUBMITTED',
        executionMode: 'LIVE_OAUTH',
        externalPostId,
      };
    } catch (err) {
      return {
        success: false,
        status: 'FAILED',
        executionMode: 'LIVE_OAUTH',
        errorMessage: err instanceof Error ? err.message : 'External publishing network error',
        needsReconciliation: true,
      };
    }
  }

  if (process.env['NODE_ENV'] === 'production') {
    return {
      success: false, status: 'FAILED', executionMode: 'LIVE_OAUTH',
      errorMessage: 'Live publishing requires a configured provider and linked account.',
    };
  }

  // Honest SANDBOX_SIMULATED mode when live provider credentials are absent
  return {
    success: true,
    status: 'PUBLISHED_SANDBOX',
    executionMode: 'SANDBOX_SIMULATED',
    externalPostId: `sandbox-${params.platform.toLowerCase()}-${randomUUID().slice(0, 8)}`,
  };
}

export interface PostizPostState {
  id: string;
  state: string;
  publishDate?: string;
  releaseURL?: string;
}

export async function listPostizPostStates(startDate: Date): Promise<PostizPostState[]> {
  const key = process.env['POSTIZ_API_KEY']?.trim();
  if (!key) return [];
  const base = process.env['POSTIZ_API_BASE_URL']?.trim() || 'https://api.postiz.com/public/v1';
  const url = new URL(`${base}/posts`);
  url.searchParams.set('startDate', startDate.toISOString());
  url.searchParams.set('endDate', new Date(Date.now() + 60_000).toISOString());
  const response = await fetch(url, {
    headers: { Authorization: key }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Postiz status lookup failed (${response.status})`);
  const body = await response.json() as { posts?: PostizPostState[] };
  if (!Array.isArray(body.posts)) throw new Error('Postiz status response contained no post list');
  return body.posts;
}
