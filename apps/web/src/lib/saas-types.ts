export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

export interface SaasUser {
  id: string;
  email: string;
  name: string;
  systemRole: 'USER' | 'SUPER_ADMIN';
  status?: string;
  emailVerified: boolean;
  onboardingCompleted: boolean;
  onboardingStep: number;
}

export interface SaasWorkspace {
  id: string;
  name: string;
  slug: string;
  planTier: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  subscriptionStatus: string;
  billingProviderMode: string;
  /** Set once the workspace has paid through Stripe; enables the billing portal. */
  stripeCustomerId?: string | null;
  monthlyClipLimit: number;
  clipsUsedThisPeriod: number;
  primaryPlatform: string;
}

export interface PlanDef {
  id: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  name: string;
  tagline: string;
  priceMonthlyUsd: number;
  monthlyClipLimit: number;
  maxCreators: number;
  maxSocialAccounts: number;
  apiKeysAllowed: number;
  features: string[];
  highlighted?: boolean;
}

export interface Creator {
  autoMonitorEnabled: boolean;
  id: string;
  handle: string;
  displayName: string;
  platform: string;
  channelUrl: string;
  /** Channel profile photo read from the platform. */
  avatarUrl?: string | null;
  tags: string[];
  requiredTopics: string[];
  bannedKeywords: string[];
  disallowLogos: boolean;
  defaultLayout: string;
  defaultCaptionStyle: string;
  enableSfx: boolean;
  spokenLanguage?: string;
  /** Why the last channel check failed, when it did. */
  sourceAccessError?: string | null;
  lastPolledAt?: string | null;
}

export interface SocialAccount {
  id: string;
  platform: string;
  accountName: string;
  accountHandle: string;
  autoPublishApproved: boolean;
  integrationMode: string;
  hasEncryptedToken?: boolean;
  /** Profile photo from the platform, set when the account is connected. */
  avatarUrl?: string | null;
}

export interface RouteRule {
  id: string;
  creatorId: string;
  socialAccountId: string;
  minComplianceScore: number;
  captionTemplate: string;
  hashtags: string[];
  enabled: boolean;
  creator?: Creator;
  socialAccount?: SocialAccount;
}

export interface ClipJob {
  id: string;
  title: string;
  sourceUrl: string;
  durationSec: number;
  layout: string;
  captionStyle: string;
  enableSfx: boolean;
  executionStatus: string;
  executionLogs: string[];
  durationMs: number;
  compliancePassed: boolean;
  complianceScore: number;
  approvalStatus: string;
  /** Why the clip was flagged for a person to check, when it was. */
  qualityIssue?: string | null;
  complianceReport: {
    matchedTopics: string[];
    disqualifiersTriggered: string[];
    reasons: string[];
  };
  creator?: Creator;
  /** The recording the clip was cut from, with its platform thumbnail. */
  sourceVideo?: { id: string; title: string; videoUrl: string; thumbnailUrl: string | null } | null;
}

export interface PublishPost {
  id: string;
  platform: string;
  captionText: string;
  status: string;
  executionMode: string;
  externalPostId?: string | null;
  errorMessage?: string | null;
  clipJob?: { title: string; creator?: { displayName: string } };
  socialAccount?: { accountHandle: string; accountName: string };
}

export interface ApiKeyItem {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  externalEventId: string;
  planTier: string;
  amountCents: number;
  currency: string;
  status: string;
  providerMode: string;
  createdAt: string;
}

export interface SupportTicketItem {
  id: string;
  subject: string;
  message: string;
  priority: string;
  status: string;
  createdAt: string;
}

export interface ChannelScanResult {
  creatorsScanned: number;
  detectedVideos: unknown[];
  unavailableChannels: string[];
  unsupportedChannels: number;
}

export function describeChannelScan(scan: ChannelScanResult) {
  const count = scan.detectedVideos.length;
  const messages: string[] = [];
  if (scan.creatorsScanned) messages.push(count ? `New uploads found: ${count}.` : 'No new YouTube uploads found.');
  if (scan.unavailableChannels.length) messages.push(`Could not read YouTube uploads for ${scan.unavailableChannels.join(', ')}. Check the channel URL and retry.`);
  if (scan.unsupportedChannels) messages.push('Scan checks YouTube channels. Other sources require a recording connector.');
  return messages.join(' ') || 'Add a monitored YouTube channel to scan for uploads.';
}

export async function apiRequest<T = unknown>(
  path: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<{ ok: boolean; status: number; json: { success?: boolean; data?: T; error?: unknown; errorCode?: string } }> {
  const headers: Record<string, string> = {
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.extraHeaders ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, json: { error: 'Could not reach Clip Network. Check your connection and retry.' } };
  }
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: unknown;
    errorCode?: string;
  };
  return { ok: res.ok, status: res.status, json };
}
