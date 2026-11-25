import { createHash } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@clip-network/shared/crypto';

const providers = {
  instagram: { platform: 'INSTAGRAM_REELS', auth: 'https://www.instagram.com/oauth/authorize', scopes: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights' },
  facebook: { platform: 'FACEBOOK_REELS', auth: 'https://www.facebook.com/dialog/oauth', scopes: 'pages_show_list,pages_read_engagement,pages_manage_posts,read_insights' },
  youtube: { platform: 'YOUTUBE_SHORTS', auth: 'https://accounts.google.com/o/oauth2/v2/auth', scopes: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload' },
  tiktok: { platform: 'TIKTOK', auth: 'https://www.tiktok.com/v2/auth/authorize/', scopes: 'user.info.basic,video.upload,video.list' },
  x: { platform: 'X', auth: 'https://x.com/i/oauth2/authorize', scopes: 'tweet.read tweet.write users.read media.write offline.access' },
} as const;

export type DirectProvider = keyof typeof providers;
export function isDirectProvider(value: unknown): value is DirectProvider {
  return typeof value === 'string' && Object.hasOwn(providers, value);
}
export function directPlatform(provider: DirectProvider) { return providers[provider].platform; }

export type DirectCredential = { provider: DirectProvider; id: string; accessToken: string; refreshToken?: string; expiresAt?: number };
export type DirectAccount = { credential: DirectCredential; name: string; handle: string; avatarUrl?: string };

export const META_VERSION = process.env['META_GRAPH_VERSION'] || 'v23.0';
const instagramGraph = 'https://graph.instagram.com';
const facebookGraph = 'https://graph.facebook.com';
const googleToken = 'https://oauth2.googleapis.com/token';
const tiktokToken = 'https://open.tiktokapis.com/v2/oauth/token/';
const xToken = 'https://api.x.com/2/oauth2/token';
const pkce = (provider: DirectProvider) => provider === 'youtube' || provider === 'x';
const basicAuth = (config: { clientId: string; secret: string }) =>
  ({ Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.secret)}`).toString('base64')}` });

export function getDirectConfig(provider: DirectProvider) {
  const prefix = provider.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const secret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  const key = process.env['ENCRYPTION_MASTER_KEY'];
  if (!clientId || !secret || !key || !/^[a-f0-9]{64}$/i.test(key)) return null;
  try {
    const app = new URL(process.env['PUBLIC_APP_URL'] || '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname);
    // Providers need HTTPS redirects; plain http is allowed for local development only.
    if (app.username || app.password || (app.protocol !== 'https:' && !(local && app.protocol === 'http:'))) return null;
    return { clientId, secret, redirectUri: new URL('/social-accounts', app.origin).href };
  } catch { return null; }
}
type Config = NonNullable<ReturnType<typeof getDirectConfig>>;

export function directAuthUrl(provider: DirectProvider, config: Config, state: string, verifier: string) {
  const entry = providers[provider];
  const url = new URL(provider === 'facebook' ? `https://www.facebook.com/${META_VERSION}/dialog/oauth` : entry.auth);
  url.search = new URLSearchParams({
    [provider === 'tiktok' ? 'client_key' : 'client_id']: config.clientId,
    redirect_uri: config.redirectUri, response_type: 'code', state, scope: entry.scopes,
    ...(provider === 'youtube' ? { access_type: 'offline', prompt: 'consent' } : {}),
    ...(pkce(provider) ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
    ...(provider === 'instagram' ? { enable_fb_login: '0', force_authentication: '1' } : {}),
  }).toString();
  return url.href;
}

export async function providerRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Social provider returned HTTP ${response.status}`);
  const data = await response.json() as { error?: string | { code?: string } };
  if (data.error && (typeof data.error === 'string' || (data.error.code && data.error.code !== 'ok'))) {
    throw new Error('Social provider rejected the request');
  }
  return data as T;
}

export function bearer(token: string) { return { Authorization: `Bearer ${token}` }; }
export function form(fields: Record<string, string>, token?: string) {
  return { method: 'POST', body: new URLSearchParams(fields), ...(token ? { headers: bearer(token) } : {}) };
}
type Token = { access_token: string; refresh_token?: string; expires_in?: number };
export async function refreshDirectCredential(credential: DirectCredential, config = getDirectConfig(credential.provider)) {
  if (credential.expiresAt && credential.expiresAt > Date.now() + 120_000) return credential;
  if (credential.provider === 'instagram' && credential.expiresAt) {
    const url = new URL(`${instagramGraph}/refresh_access_token`);
    url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: credential.accessToken }).toString();
    const refreshed = await providerRequest<Token>(url.href);
    if (!refreshed.access_token || !refreshed.expires_in) throw new Error('Instagram token could not be renewed');
    return { ...credential, accessToken: refreshed.access_token, expiresAt: Date.now() + refreshed.expires_in * 1000 };
  }
  if (!credential.refreshToken || !['youtube', 'tiktok', 'x'].includes(credential.provider)) return credential;
  if (!config) throw new Error('Social app credentials are unavailable');
  if (credential.provider === 'x') {
    const data = await providerRequest<Token>(xToken, { method: 'POST', headers: basicAuth(config), body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: config.clientId,
    }) });
    if (!data.access_token) throw new Error('Provider did not issue an access token');
    return { ...credential, accessToken: data.access_token, refreshToken: data.refresh_token || credential.refreshToken, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 };
  }
  const youtube = credential.provider === 'youtube';
  const data = await providerRequest<Token>(youtube ? googleToken : tiktokToken, form({
    [youtube ? 'client_id' : 'client_key']: config.clientId,
    client_secret: config.secret, grant_type: 'refresh_token', refresh_token: credential.refreshToken,
  }));
  if (!data.access_token) throw new Error('Provider did not issue an access token');
  return { ...credential, accessToken: data.access_token, refreshToken: data.refresh_token || credential.refreshToken, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

export async function exchangeDirectCode(provider: DirectProvider, config: Config, code: string, verifier: string): Promise<DirectAccount[]> {
  const fields = {
    [provider === 'tiktok' ? 'client_key' : 'client_id']: config.clientId,
    client_secret: config.secret, redirect_uri: config.redirectUri, code, grant_type: 'authorization_code',
    ...(pkce(provider) ? { code_verifier: verifier } : {}),
  };
  const urls = { instagram: 'https://api.instagram.com/oauth/access_token', facebook: `${facebookGraph}/${META_VERSION}/oauth/access_token`, youtube: googleToken, tiktok: tiktokToken, x: xToken };
  const exchangeUrl = new URL(urls[provider]);
  if (provider === 'facebook') exchangeUrl.search = new URLSearchParams(fields).toString();
  // X confidential clients authenticate with HTTP Basic rather than a client_secret field.
  const xFields = { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: verifier, client_id: config.clientId };
  let token = await providerRequest<Token>(exchangeUrl.href, provider === 'facebook' ? {}
    : provider === 'x' ? { method: 'POST', headers: basicAuth(config), body: new URLSearchParams(xFields) } : form(fields));
  if (!token.access_token) throw new Error('Provider did not issue an access token');
  if (provider === 'instagram' || provider === 'facebook') {
    const instagram = provider === 'instagram';
    const url = new URL(instagram ? `${instagramGraph}/access_token` : `${facebookGraph}/${META_VERSION}/oauth/access_token`);
    url.search = new URLSearchParams(instagram ? {
      grant_type: 'ig_exchange_token', client_secret: config.secret, access_token: token.access_token,
    } : {
      grant_type: 'fb_exchange_token', client_id: config.clientId, client_secret: config.secret, fb_exchange_token: token.access_token,
    }).toString();
    token = await providerRequest<Token>(url.href);
    if (!token.access_token) throw new Error('Provider did not issue a long-lived token');
  }
  const headers = bearer(token.access_token);
  const account = (id: string, name: string, handle: string, accessToken = token.access_token, avatarUrl?: string): DirectAccount => ({
    name: name || handle, handle, ...(safeImageUrl(avatarUrl) ? { avatarUrl: safeImageUrl(avatarUrl)! } : {}),
    credential: { provider, id, accessToken, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}), ...(provider !== 'facebook' && token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}) },
  });
  switch (provider) {
    case 'instagram': {
      const profile = await providerRequest<{ user_id: string; username: string; name?: string; profile_picture_url?: string }>(`${instagramGraph}/${META_VERSION}/me?fields=user_id,username,name,profile_picture_url`, { headers });
      return [account(String(profile.user_id), profile.name || profile.username, `@${profile.username}`, undefined, profile.profile_picture_url)];
    }
    case 'facebook': {
      const result = await providerRequest<{ data: { id: string; name: string; access_token: string; tasks?: string[]; picture?: { data?: { url?: string } } }[] }>(`${facebookGraph}/${META_VERSION}/me/accounts?fields=id,name,access_token,tasks,picture{url}&limit=100`, { headers });
      return result.data.filter((page) => page.access_token && page.tasks?.some((task) => task === 'CREATE_CONTENT' || task === 'MANAGE'))
        .map((page) => account(page.id, page.name, page.id, page.access_token, page.picture?.data?.url));
    }
    case 'youtube': {
      type Thumbs = { default?: { url?: string }; medium?: { url?: string } };
      const result = await providerRequest<{ items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: Thumbs } }[] }>('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers });
      return (result.items ?? []).map((channel) => account(channel.id, channel.snippet.title, channel.snippet.customUrl || channel.id,
        undefined, channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url));
    }
    case 'tiktok': {
      const result = await providerRequest<{ data: { user: { open_id: string; display_name: string; avatar_url?: string } } }>('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url', { headers });
      const { open_id: id, display_name: name, avatar_url: avatar } = result.data.user;
      return [account(id, name, name || id, undefined, avatar)];
    }
    case 'x': {
      const result = await providerRequest<{ data: { id: string; name: string; username: string; profile_image_url?: string } }>('https://api.x.com/2/users/me?user.fields=profile_image_url', { headers });
      const { id, name, username, profile_image_url: avatar } = result.data;
      // The default image is 48px; the 200px variant is the same URL with a different suffix.
      return [account(id, name, `@${username}`, undefined, avatar?.replace(/_normal(\.\w+)$/, '_200x200$1'))];
    }
  }
}

/** Accepts only an https image URL without credentials, for showing profile photos. */
export function safeImageUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function encodeDirectCredential(value: DirectCredential) {
  return encryptSecret(`direct-social:${JSON.stringify(value)}`);
}
export function readDirectCredential(encrypted: string | null): DirectCredential | null {
  if (!encrypted) return null;
  const raw = decryptSecret(encrypted);
  if (!raw.startsWith('direct-social:')) return null;
  const value = JSON.parse(raw.slice('direct-social:'.length)) as DirectCredential;
  if (!isDirectProvider(value.provider) || typeof value.accessToken !== 'string' || !value.accessToken ||
    !/^[\w.-]{1,200}$/.test(value.id)) throw new Error('Invalid direct social credential');
  return value;
}
