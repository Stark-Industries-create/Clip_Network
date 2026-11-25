import { describe, expect, it } from 'vitest';
import { assertProductionConfig } from '../production-config.js';

const configured = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://database/clipnetwork',
  ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
  PUBLIC_APP_URL: 'https://app.example.test',
  S3_ENDPOINT: 'https://media.example.test',
  S3_BUCKET: 'clips',
  S3_ACCESS_KEY_ID: 'fixture',
  S3_SECRET_ACCESS_KEY: 'fixture',
  RESEND_API_KEY: 'fixture',
  EMAIL_FROM: 'test@example.test',
  STRIPE_SECRET_KEY: 'sk_live_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STRIPE_PRICE_ENTERPRISE: 'price_enterprise',
  POSTIZ_API_KEY: 'fixture',
};

describe('Production startup configuration', () => {
  it('accepts valid production configuration and keeps local sandbox startup available', () => {
    expect(() => assertProductionConfig('api', configured)).not.toThrow();
    expect(() => assertProductionConfig('worker', configured)).not.toThrow();
    expect(() => assertProductionConfig('api', { ...configured, RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY/);
    // Stripe, social logins and email may come from the Control Center instead of the environment.
    const adminManaged = { ...configured, POSTIZ_API_KEY: '', RESEND_API_KEY: '', EMAIL_FROM: '', STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '', STRIPE_PRICE_STARTER: '', STRIPE_PRICE_PRO: '', STRIPE_PRICE_ENTERPRISE: '' };
    expect(() => assertProductionConfig('api', adminManaged)).not.toThrow();
    expect(() => assertProductionConfig('worker', adminManaged)).not.toThrow();
    expect(() => assertProductionConfig('api', { NODE_ENV: 'development' })).not.toThrow();
  });

  it('rejects malformed billing keys and half-configured social logins in production', () => {
    expect(() => assertProductionConfig('api', { ...configured, STRIPE_SECRET_KEY: 'pk_live_fixture' }))
      .toThrow(/STRIPE_SECRET_KEY/);
    expect(() => assertProductionConfig('api', { ...configured, STRIPE_SECRET_KEY: 'sk_test_fixture' })).not.toThrow();
    expect(() => assertProductionConfig('worker', { ...configured, X_CLIENT_ID: 'fixture' })).toThrow(/X_CLIENT_SECRET/);
    expect(() => assertProductionConfig('worker', {
      ...configured, POSTIZ_API_KEY: '', INSTAGRAM_CLIENT_ID: 'fixture', INSTAGRAM_CLIENT_SECRET: 'fixture',
    })).not.toThrow();
  });

  it('names invalid settings without exposing values', () => {
    const invalid = { ...configured, DATABASE_URL: 'file:private-path', ENCRYPTION_MASTER_KEY: 'sensitive-placeholder', YOUTUBE_CLIENT_ID: 'fixture' };
    expect(() => assertProductionConfig('api', invalid)).toThrow(/DATABASE_URL, ENCRYPTION_MASTER_KEY, YOUTUBE_CLIENT_SECRET, YOUTUBE_MADE_FOR_KIDS/);
    expect(() => assertProductionConfig('api', invalid)).not.toThrow(/private-path|sensitive-placeholder/);
  });

  it('rejects an out-of-range worker pool and the removed single-workspace switches', () => {
    expect(() => assertProductionConfig('worker', { ...configured, WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY/);
    expect(() => assertProductionConfig('worker', { ...configured, WORKER_CONCURRENCY: '8' })).not.toThrow();
    expect(() => assertProductionConfig('worker', { ...configured, SOURCE_AUTOMATION_PUBLISH_WORKSPACE_ID: 'ws' }))
      .toThrow(/SOURCE_AUTOMATION_PUBLISH_WORKSPACE_ID \(replaced by workspace settings/);
  });

  it('rejects a disabled production worker and an incomplete connector', () => {
    expect(() => assertProductionConfig('worker', { ...configured, CHANNEL_MONITOR_INTERVAL_MS: '0' })).toThrow(/CHANNEL_MONITOR_INTERVAL_MS/);
    expect(() => assertProductionConfig('worker', { ...configured, SOURCE_CONNECTOR_ADMIN_TOKEN: 'fixture' }))
      .toThrow(/SOURCE_CONNECTOR_WORKSPACE_ID.*SOURCE_CONNECTOR_SUBSCRIPTIONS_URL.*SOURCE_AUTOMATION_ENABLED/);
  });
});
