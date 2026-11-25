import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { LEGAL_EMAIL, LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = { title: 'Privacy Policy · Clip Network' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>This policy explains what Clip Network collects, why, who processes it for us, and your choices.</p>

      <h2>What we collect</h2>
      <ul>
        <li>Account details: name, email address and a securely hashed password.</li>
        <li>Workspace data: tagged channels, campaign rules, routing rules, clips and their review history.</li>
        <li>
          Connected accounts: access tokens for the social accounts you connect, encrypted at rest and never shown in the
          browser.
        </li>
        <li>
          Recording data: captions, audio-derived transcripts and short video sections of the public recordings you ask us to
          clip, plus engagement numbers for clips you publish.
        </li>
        <li>Billing records from our payment provider. We never see or store full card numbers.</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        To run the service: find moments, render and caption clips, publish to your destinations, show analytics, bill your
        plan, keep the service secure and answer support requests. We do not sell personal data.
      </p>

      <h2>Who processes data for us</h2>
      <ul>
        <li>Cloud hosting and file storage for clips and transcripts.</li>
        <li>A payment processor for subscriptions, and an email provider for account emails.</li>
        <li>
          Speech-to-text and AI ranking services, when enabled, which receive recording audio or transcripts to find
          moments. They process it on our behalf.
        </li>
        <li>The social platforms you publish to, which receive the clips and captions you send them.</li>
      </ul>

      <h2>Retention and your rights</h2>
      <p>
        We keep workspace data while your workspace is active and delete it after you close it, except records we must keep
        by law. You can ask us to access, correct, export or delete your personal data, and disconnect any social account at
        any time in Social Accounts.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy requests: <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>. See also our{' '}
        <Link href="/terms">Terms of Service</Link>.
      </p>
    </LegalPage>
  );
}
