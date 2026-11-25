import { z } from 'zod';

export const CreatorPlatformSchema = z.enum(['TWITCH', 'YOUTUBE', 'KICK']);
export type CreatorPlatform = z.infer<typeof CreatorPlatformSchema>;

export const SocialPlatformSchema = z.enum([
  'INSTAGRAM_REELS',
  'FACEBOOK_REELS',
  'TIKTOK',
  'YOUTUBE_SHORTS',
  'X',
]);
export type SocialPlatform = z.infer<typeof SocialPlatformSchema>;

export const CaptionStyleIdSchema = z.enum([
  'HIGH_ENERGY',
  'BOLD_CREATOR',
  'CLEAN_MINIMAL',
  'PODCAST_PREMIUM',
]);
export type CaptionStyleId = z.infer<typeof CaptionStyleIdSchema>;

export const LayoutModeSchema = z.enum(['SPLIT_FACECAM_BOTTOM', 'CENTER_CROP_9_16']);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;

export const SfxPresetIdSchema = z.enum(['WHOOSH', 'POP', 'RISER', 'BOOM', 'CHIME', 'GLITCH']);
export type SfxPresetId = z.infer<typeof SfxPresetIdSchema>;

/** Whisper language code for a creator's speech: `auto`, or ISO 639-1 such as `en`, `ne`, `hi`. */
export const SpokenLanguageSchema = z.string().regex(/^(auto|[a-z]{2,3})$/);

export const CreateCreatorRequestSchema = z.object({
  handle: z.string().min(2).max(80),
  displayName: z.string().min(2).max(120),
  platform: CreatorPlatformSchema,
  channelUrl: z.string().url(),
  tags: z.array(z.string().min(1).max(40)).default([]),
  requiredTopics: z.array(z.string().min(1).max(120)).default([]),
  bannedKeywords: z.array(z.string().min(1).max(120)).default([]),
  disallowLogos: z.boolean().default(true),
  defaultLayout: LayoutModeSchema.default('SPLIT_FACECAM_BOTTOM'),
  defaultCaptionStyle: CaptionStyleIdSchema.default('HIGH_ENERGY'),
  enableSfx: z.boolean().default(true),
  spokenLanguage: SpokenLanguageSchema.default('auto'),
  facecamCrop: z
    .object({
      x: z.number().int().nonnegative().default(0),
      y: z.number().int().nonnegative().default(0),
      width: z.number().int().positive().default(494),
      height: z.number().int().positive().default(278),
    })
    .optional(),
});
export type CreateCreatorRequest = z.infer<typeof CreateCreatorRequestSchema>;

export const CreateSocialAccountRequestSchema = z.object({
  platform: SocialPlatformSchema,
  accountName: z.string().min(2).max(120),
  accountHandle: z.string().min(2).max(80),
  accessToken: z.string().min(4).max(2048).optional(),
  autoPublishApproved: z.boolean().default(false),
  timezone: z.string().min(2).max(64).default('UTC'),
});
export type CreateSocialAccountRequest = z.infer<typeof CreateSocialAccountRequestSchema>;

export const ToggleAutoPublishRequestSchema = z.object({
  autoPublishApproved: z.boolean(),
});
export type ToggleAutoPublishRequest = z.infer<typeof ToggleAutoPublishRequestSchema>;

export const CreateRouteRuleRequestSchema = z.object({
  creatorId: z.string().uuid(),
  socialAccountId: z.string().uuid(),
  minComplianceScore: z.number().int().min(0).max(100).default(75),
  captionTemplate: z.string().max(1500).default('{hook} {tags}'),
  hashtags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
export type CreateRouteRuleRequest = z.infer<typeof CreateRouteRuleRequestSchema>;

export const RegisterSourceVideoSchema = z.object({
  recordingStatus: z.enum(['LIVE', 'FINALIZING', 'REPLAY']).optional(),
  creatorId: z.string().uuid(),
  externalVideoId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  title: z.string().trim().min(1).max(300),
  videoUrl: z.string().url().max(2048),
  publishedAt: z.string().datetime({ offset: true }),
});

export const IngestStreamRequestSchema = z.object({
  creatorId: z.string().uuid(),
  sourceUrl: z.string().url(),
  title: z.string().min(2).max(200).optional(),
  startSec: z.number().nonnegative().default(0),
  endSec: z.number().positive().default(60),
  transcriptText: z.string().min(10).max(20000).optional(),
  layout: LayoutModeSchema.optional(),
  captionStyle: CaptionStyleIdSchema.optional(),
  enableSfx: z.boolean().optional(),
  renderVideo: z.boolean().default(false),
});
export type IngestStreamRequest = z.infer<typeof IngestStreamRequestSchema>;

export const ClipDecisionRequestSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().max(500).optional(),
});
export type ClipDecisionRequest = z.infer<typeof ClipDecisionRequestSchema>;

// ============================================================================
// SaaS Commercial Plans, Auth, Onboarding, Multi-Tenancy, Billing & Admin
// ============================================================================

export const PlanTierSchema = z.enum(['FREE', 'STARTER', 'PRO', 'ENTERPRISE']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

export const WorkspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const SystemRoleSchema = z.enum(['USER', 'SUPER_ADMIN']);
export type SystemRole = z.infer<typeof SystemRoleSchema>;

export const ExecutionStatusSchema = z.enum([
  'PENDING',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export interface SaasPlanDefinition {
  id: PlanTier;
  name: string;
  tagline: string;
  priceMonthlyUsd: number;
  monthlyClipLimit: number;
  /** Hours of recordings the worker analyzes per billing period. */
  monthlyAnalysisHours: number;
  /** Longest single recording analyzed, in hours. */
  maxRecordingHours: number;
  /** Jobs (analysis, render, publish) one workspace may run at the same time. */
  workerConcurrency: number;
  maxCreators: number;
  maxSocialAccounts: number;
  apiKeysAllowed: number;
  features: readonly string[];
  highlighted?: boolean;
}

export const SAAS_PLANS: Record<PlanTier, SaasPlanDefinition> = {
  FREE: {
    id: 'FREE',
    name: 'Free',
    tagline: 'Test the clipping engine on your first channel.',
    priceMonthlyUsd: 0,
    monthlyClipLimit: 10,
    monthlyAnalysisHours: 5,
    maxRecordingHours: 2,
    workerConcurrency: 1,
    maxCreators: 2,
    maxSocialAccounts: 2,
    apiKeysAllowed: 1,
    features: [
      '10 AI-aligned clips / month',
      'Up to 2 tagged creators & 2 social accounts',
      'Voice-synced captions + procedural SFX',
      'Human approval gate + compliance scoring',
    ],
  },
  STARTER: {
    id: 'STARTER',
    name: 'Starter',
    tagline: 'For solo clippers running multi-platform fan pages.',
    priceMonthlyUsd: 29,
    monthlyClipLimit: 100,
    monthlyAnalysisHours: 40,
    maxRecordingHours: 6,
    workerConcurrency: 1,
    maxCreators: 10,
    maxSocialAccounts: 10,
    apiKeysAllowed: 3,
    features: [
      '100 AI-aligned clips / month',
      '10 creators & 10 linked social accounts',
      'Opt-in auto-publishing per account',
      'AES-256-GCM encrypted OAuth vault & API keys',
    ],
  },
  PRO: {
    id: 'PRO',
    name: 'Pro',
    tagline: 'High-volume clipping agencies & creator networks.',
    priceMonthlyUsd: 99,
    monthlyClipLimit: 500,
    monthlyAnalysisHours: 200,
    maxRecordingHours: 12,
    workerConcurrency: 2,
    maxCreators: 50,
    maxSocialAccounts: 50,
    apiKeysAllowed: 10,
    highlighted: true,
    features: [
      '500 AI-aligned clips / month',
      '50 creators & 50 linked social accounts',
      'Priority engine queue + retry & cancellation',
      'Multi-seat RBAC workspace & full audit logs',
    ],
  },
  ENTERPRISE: {
    id: 'ENTERPRISE',
    name: 'Enterprise',
    tagline: 'Custom scale for media networks & brand campaigns.',
    priceMonthlyUsd: 299,
    monthlyClipLimit: 5000,
    monthlyAnalysisHours: 2000,
    maxRecordingHours: 24,
    workerConcurrency: 4,
    maxCreators: 500,
    maxSocialAccounts: 500,
    apiKeysAllowed: 50,
    features: [
      '5,000 AI-aligned clips / month',
      'Unlimited campaign rules & dedicated support',
      'Custom SLA, webhooks & compliance exports',
      'Dedicated tenant isolation & SSO-ready auth',
    ],
  },
};

export const RegisterRequestSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(180),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[A-Za-z]/, 'Password must include a letter')
    .regex(/[0-9]/, 'Password must include a number'),
  workspaceName: z.string().trim().min(2).max(100).optional(),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms of Service and Privacy Policy.' }),
  }),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().default(false),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const VerifyEmailRequestSchema = z.object({
  token: z.string().min(8).max(256),
});

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().trim().email(),
});

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(8).max(256),
  newPassword: z
    .string()
    .min(8)
    .max(128)
    .regex(/[A-Za-z]/)
    .regex(/[0-9]/),
});

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z
    .string()
    .min(8)
    .max(128)
    .regex(/[A-Za-z]/)
    .regex(/[0-9]/),
});

export const UpdateProfileRequestSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  workspaceName: z.string().trim().min(2).max(100).optional(),
});

export const CompleteOnboardingRequestSchema = z.object({
  workspaceName: z.string().trim().min(2).max(100),
  primaryPlatform: CreatorPlatformSchema.default('TWITCH'),
  selectedPlan: PlanTierSchema.default('FREE'),
});

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const CheckoutPlanRequestSchema = z.object({
  planTier: PlanTierSchema,
});

export const BillingWebhookPayloadSchema = z.object({
  eventId: z.string().min(4).max(120),
  eventType: z.enum([
    'checkout.session.completed',
    'invoice.paid',
    'invoice.payment_failed',
    'customer.subscription.deleted',
  ]),
  workspaceId: z.string().uuid(),
  planTier: PlanTierSchema.optional(),
  amountCents: z.number().int().nonnegative().default(0),
});
export type BillingWebhookPayload = z.infer<typeof BillingWebhookPayloadSchema>;

export const CreateSupportTicketRequestSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(10).max(4000),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
});

export const AdminUpdateUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

export const AdminOverridePlanSchema = z.object({
  planTier: PlanTierSchema,
  subscriptionStatus: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELLED']).default('ACTIVE'),
});

export const AdminUpdateTicketSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']),
});

export const InviteMemberRequestSchema = z.object({
  email: z.string().trim().email().max(180),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

export const AcceptInviteRequestSchema = z.object({
  token: z.string().min(8).max(256),
});

export const UpdateMemberRoleRequestSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
});

export const NotificationPreferencesSchema = z.object({
  approvals: z.boolean().default(true),
  failures: z.boolean().default(true),
  billing: z.boolean().default(true),
  security: z.boolean().default(true),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export interface CampaignComplianceResult {
  passed: boolean;
  score: number;
  matchedTopics: string[];
  disqualifiersTriggered: string[];
  reasons: string[];
}

const GENERIC_CLICKBAIT_PATTERNS: readonly RegExp[] = [
  /i can'?t believe that happened/i,
  /wait until the end.*crazy/i,
  /you won'?t believe what happened/i,
];

/**
 * Evaluates a candidate clip against a creator's campaign requirements & disqualifiers.
 */
export function evaluateClipCompliance(params: {
  transcript: string;
  caption: string;
  requiredTopics: readonly string[];
  bannedKeywords: readonly string[];
  disallowLogos: boolean;
  hasAddedLogos: boolean;
}): CampaignComplianceResult {
  const haystack = `${params.transcript} ${params.caption}`.toLowerCase();
  const matchedTopics: string[] = [];
  const disqualifiersTriggered: string[] = [];
  const reasons: string[] = [];

  if (params.disallowLogos && params.hasAddedLogos) {
    disqualifiersTriggered.push('LOGO_DETECTED');
    reasons.push('Added logos or watermarks are strictly prohibited by creator campaign rules.');
  }

  for (const kw of params.bannedKeywords) {
    const clean = kw.trim().toLowerCase();
    if (clean && haystack.includes(clean)) {
      disqualifiersTriggered.push(`BANNED_KEYWORD:${kw}`);
      reasons.push(`Contains banned keyword "${kw}".`);
    }
  }

  for (const pat of GENERIC_CLICKBAIT_PATTERNS) {
    if (pat.test(params.caption)) {
      disqualifiersTriggered.push('LOW_VALUE_CLICKBAIT');
      reasons.push('Caption contains generic clickbait phrasing that adds no editorial value.');
      break;
    }
  }

  for (const topic of params.requiredTopics) {
    const clean = topic.trim().toLowerCase();
    if (clean && haystack.includes(clean)) {
      matchedTopics.push(topic);
    }
  }

  if (params.requiredTopics.length > 0 && matchedTopics.length === 0) {
    disqualifiersTriggered.push('MISSING_REQUIRED_TOPIC');
    reasons.push(
      `Clip does not match any required campaign topic (${params.requiredTopics.join(', ')}).`,
    );
  }

  let score = 100;
  if (params.requiredTopics.length > 0 && matchedTopics.length === 0) score -= 50;
  if (disqualifiersTriggered.includes('LOGO_DETECTED')) score -= 60;
  if (disqualifiersTriggered.includes('LOW_VALUE_CLICKBAIT')) score -= 35;
  score -= disqualifiersTriggered.filter((d) => d.startsWith('BANNED_KEYWORD:')).length * 30;
  score = Math.max(0, Math.min(100, score));

  return {
    passed: disqualifiersTriggered.length === 0 && score >= 70,
    score,
    matchedTopics,
    disqualifiersTriggered,
    reasons,
  };
}
