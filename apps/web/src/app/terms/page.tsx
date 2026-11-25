import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { LEGAL_EMAIL, LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = { title: 'Terms of Service · Clip Network' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        These terms govern your use of Clip Network, a service that finds moments in creator recordings, turns them into
        short vertical clips and publishes them to social accounts you connect. By creating a workspace you agree to them
        on behalf of yourself and the organisation you represent.
      </p>

      <h2>Your content and permissions</h2>
      <ul>
        <li>
          You may only tag channels, and clip and publish recordings, that you own or that their owner has authorised you to
          use. You are responsible for holding and documenting that permission.
        </li>
        <li>
          You keep all rights to your content. You give us the permissions needed to process it for you: downloading the
          parts of recordings needed for analysis and clips, transcribing audio, rendering clips and publishing them to the
          destinations you choose.
        </li>
        <li>
          You must follow the rules of every platform you use through Clip Network, including YouTube, Twitch, Kick,
          Instagram, Facebook, TikTok and X.
        </li>
      </ul>

      <h2>Automatic publishing</h2>
      <p>
        Clips are held for human approval unless you turn on automatic publishing for your workspace and for each destination
        account. When automatic publishing is on, you are responsible for what is posted to your accounts.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>No content that infringes others&apos; rights, deceives viewers, or breaks the law.</li>
        <li>No attempts to access other workspaces, disrupt the service, or work around plan limits.</li>
        <li>We may suspend workspaces that break these terms or receive valid takedown notices.</li>
      </ul>

      <h2>Plans and billing</h2>
      <p>
        Paid plans renew monthly until cancelled. Plan limits (clips, analysed recording hours, creators and accounts) reset
        each billing period. You can cancel at any time in Billing; access continues until the end of the paid period.
      </p>

      <h2>Service and liability</h2>
      <p>
        The service depends on third-party platforms that can change or limit access. We provide it as is, and to the extent
        the law allows, we are not liable for indirect losses or for content published at your direction.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or takedown notices: <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>. See also our{' '}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </LegalPage>
  );
}
