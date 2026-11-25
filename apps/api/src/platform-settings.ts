import type { PrismaClient } from '@prisma/client';
import { decryptSecret, encryptSecret } from '@clip-network/shared/crypto';

/**
 * Integration credentials a super admin can enter in the Control Center instead of the server's
 * environment. Saved values are encrypted in the database and applied over `process.env`, so every
 * integration keeps reading its usual variable. Clearing a saved value restores the environment's.
 */
export type SettingField = { key: string; label: string; secret: boolean; pattern?: RegExp; hint?: string };
export type SettingGroup = { id: string; title: string; description: string; docsUrl?: string; fields: SettingField[] };

const oauth = (prefix: string, idLabel = 'Client ID', secretLabel = 'Client secret'): SettingField[] => [
  { key: `${prefix}_CLIENT_ID`, label: idLabel, secret: false, pattern: /^[\w.\-:]{4,200}$/ },
  { key: `${prefix}_CLIENT_SECRET`, label: secretLabel, secret: true, pattern: /^\S{8,300}$/ },
];

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'stripe', title: 'Stripe payments',
    description: 'Paste your secret key. Plan prices are created in Stripe automatically; then create the webhook with one click.',
    docsUrl: 'https://dashboard.stripe.com/apikeys',
    fields: [
      { key: 'STRIPE_SECRET_KEY', label: 'Secret key', secret: true, pattern: /^(sk|rk)_(live|test)_\w{10,}$/, hint: 'sk_live_… or sk_test_…' },
      { key: 'STRIPE_WEBHOOK_SECRET', label: 'Webhook signing secret', secret: true, pattern: /^whsec_\w{10,}$/, hint: 'whsec_…' },
      { key: 'STRIPE_PRICE_STARTER', label: 'Starter price ID (optional)', secret: false, pattern: /^price_\w+$/ },
      { key: 'STRIPE_PRICE_PRO', label: 'Pro price ID (optional)', secret: false, pattern: /^price_\w+$/ },
      { key: 'STRIPE_PRICE_ENTERPRISE', label: 'Enterprise price ID (optional)', secret: false, pattern: /^price_\w+$/ },
    ],
  },
  {
    id: 'youtube', title: 'YouTube (Google)', description: 'Google Cloud OAuth client (Web application) with the YouTube Data API v3 enabled.',
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    fields: [...oauth('YOUTUBE'), { key: 'YOUTUBE_API_KEY', label: 'Data API key (optional, adds comment counts)', secret: true, pattern: /^AIza[\w-]{30,}$/, hint: 'AIza…' }, { key: 'YOUTUBE_MADE_FOR_KIDS', label: 'Uploads are made for kids (yes or no)', secret: false, pattern: /^(yes|no)$/, hint: 'yes or no' }],
  },
  {
    id: 'google-login', title: 'Sign in with Google',
    description: 'Lets users sign up and log in with Google. Leave empty to reuse the YouTube client above; register the sign-in redirect URI on it too.',
    docsUrl: 'https://console.cloud.google.com/apis/credentials', fields: oauth('GOOGLE'),
  },
  { id: 'facebook', title: 'Facebook Pages', description: 'Meta app with Facebook Login for Business.', docsUrl: 'https://developers.facebook.com/apps', fields: oauth('FACEBOOK', 'App ID', 'App secret') },
  { id: 'instagram', title: 'Instagram', description: 'Meta app with the Instagram API (Instagram login) product.', docsUrl: 'https://developers.facebook.com/apps', fields: oauth('INSTAGRAM', 'Instagram app ID', 'Instagram app secret') },
  { id: 'tiktok', title: 'TikTok', description: 'TikTok for Developers app with Login Kit and the Content Posting API.', docsUrl: 'https://developers.tiktok.com/apps', fields: oauth('TIKTOK', 'Client key', 'Client secret') },
  { id: 'x', title: 'X (Twitter)', description: 'X developer app with OAuth 2.0 (Web App, confidential client) and media upload access.', docsUrl: 'https://developer.x.com/en/portal/dashboard', fields: oauth('X') },
  {
    id: 'email', title: 'Email (Resend)', description: 'Sends verification, password reset and invite emails.', docsUrl: 'https://resend.com/api-keys',
    fields: [
      { key: 'RESEND_API_KEY', label: 'API key', secret: true, pattern: /^re_\w{8,}$/ },
      { key: 'EMAIL_FROM', label: 'From address', secret: false, pattern: /^[^<>\r\n]{0,80}<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/, hint: 'Clip Network <hello@yourdomain.com>' },
    ],
  },
];

const FIELDS = new Map(SETTING_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));

const baseEnv = new Map<string, string | undefined>();
const applied = new Set<string>();
let lastLoad = 0;

function apply(values: Map<string, string>) {
  for (const key of FIELDS.keys()) {
    if (!baseEnv.has(key)) baseEnv.set(key, process.env[key]);
    const value = values.get(key);
    if (value !== undefined) {
      process.env[key] = value;
      applied.add(key);
    } else if (applied.has(key)) {
      const original = baseEnv.get(key);
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
      applied.delete(key);
    }
  }
}

/** Reads saved settings into `process.env`. Rows that fail to decrypt are skipped. */
export async function loadPlatformSettings(prisma: PrismaClient) {
  const rows = await prisma.platformSetting.findMany();
  const values = new Map<string, string>();
  for (const row of rows) {
    if (!FIELDS.has(row.key)) continue;
    try { values.set(row.key, decryptSecret(row.encryptedValue)); } catch { console.warn('Platform setting could not be decrypted', row.key); }
  }
  apply(values);
  lastLoad = Date.now();
}

/** Re-reads settings at most once per `maxAgeMs`, so every process sees admin changes quickly. */
export async function refreshPlatformSettings(prisma: PrismaClient, maxAgeMs = 30_000) {
  if (Date.now() - lastLoad < maxAgeMs) return;
  await loadPlatformSettings(prisma).catch(() => { lastLoad = Date.now(); });
}

export function settingSource(key: string): 'ADMIN' | 'ENVIRONMENT' | 'MISSING' {
  if (applied.has(key)) return 'ADMIN';
  return (baseEnv.has(key) ? baseEnv.get(key) : process.env[key])?.trim() ? 'ENVIRONMENT' : 'MISSING';
}

/** A short, non-secret preview of a value for the admin screen. */
export function settingPreview(key: string) {
  const value = process.env[key]?.trim();
  if (!value) return null;
  if (!FIELDS.get(key)?.secret) return value;
  const prefix = /^[a-z]+_(live_|test_)?/i.exec(value)?.[0] ?? '';
  return `${prefix}…${value.slice(-4)}`;
}

/** Returns the first invalid field's error, or null when every non-empty value matches its format. */
export function validateSettings(values: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(values)) {
    const field = FIELDS.get(key);
    if (!field) return `Unknown setting ${key}.`;
    if (value !== null && typeof value !== 'string') return `${field.label} must be text.`;
    const text = (value ?? '').trim();
    if (text.length > 500) return `${field.label} is too long.`;
    if (text && field.pattern && !field.pattern.test(text)) return `${field.label} does not look right${field.hint ? ` (expected ${field.hint})` : ''}.`;
  }
  return null;
}

/** Saves validated values (empty clears the saved value) and applies them to this process. */
export async function savePlatformSettings(prisma: PrismaClient, values: Record<string, string | null>, userId: string) {
  for (const [key, raw] of Object.entries(values)) {
    if (!FIELDS.has(key)) continue;
    const value = raw?.trim();
    if (!value) await prisma.platformSetting.deleteMany({ where: { key } });
    else {
      const encryptedValue = encryptSecret(value);
      await prisma.platformSetting.upsert({
        where: { key }, update: { encryptedValue, updatedById: userId }, create: { key, encryptedValue, updatedById: userId },
      });
    }
  }
  await loadPlatformSettings(prisma);
}
