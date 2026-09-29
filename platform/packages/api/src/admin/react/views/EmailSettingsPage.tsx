/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Button } from '@astryxdesign/core/Button';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { useState } from 'react';
import { useRequest, useView } from 'react-fate';
import type { EmailDomainManagement, EmailRecipientPolicy } from '../../../email/settings.ts';
import { EmailSettingsView, emailSettingsRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { FormTextArea } from './FormControls.tsx';
import { Layout } from './Layout.tsx';

const META = 'font-size: 0.8rem; color: #666';
const EMAIL_SETUP_GUIDE = 'https://void.cloud/guide/platform/installation/credentials#enable-email';

export function EmailSettingsPage({
  path,
  platformName,
  username,
  emailEnabled,
}: AdminPageProps & { emailEnabled?: boolean }) {
  if (emailEnabled === false) {
    return (
      <Layout platformName={platformName} title="Email" username={username}>
        <h1>Email</h1>
        <div className="void-admin-email-disabled-content">
          <p>Email is not enabled on this platform.</p>
          <p>Set up a shared sender domain and Cloudflare zone, then upgrade the platform.</p>
          <Button as="a" href={EMAIL_SETUP_GUIDE} label="How to enable email" variant="secondary" />
        </div>
      </Layout>
    );
  }
  return <EnabledEmailSettingsPage path={path} platformName={platformName} username={username} />;
}

function EnabledEmailSettingsPage({ path, platformName, username }: AdminPageProps) {
  const { emailSettings: ref } = useRequest(emailSettingsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(EmailSettingsView, ref);
  if (!pageData) {
    throw new Error('Email settings are unavailable.');
  }
  const { policy, management, senderDomain } = pageData;
  const [mode, setMode] = useState(policy.mode);
  const [domainManagement, setDomainManagement] = useState(management);
  return (
    <Layout platformName={platformName} title="Email" username={username}>
      <h1>Email</h1>
      <p style={META}>
        Installation-wide settings. Per-project usage, caps and domains live on each project's email
        page (Projects → project → Email).
      </p>

      <h2>Recipient policy</h2>
      <p>
        Choose which recipients can receive email sent from the shared sender
        {senderDomain ? (
          <>
            {' '}
            (<code>{`<slug>+tag@${senderDomain}`}</code>)
          </>
        ) : null}
        . This does not affect email sent from custom domains.
      </p>
      <form method="post" action="/admin/email/policy" className="void-admin-email-choice-form">
        <RadioList
          label="Recipient policy"
          isLabelHidden
          size="sm"
          htmlName="mode"
          value={mode}
          onChange={(value: string) => setMode(value as EmailRecipientPolicy['mode'])}
        >
          <RadioListItem
            value="verified"
            label="verified"
            description="Only each project's verified destinations (default)"
          />
          <RadioListItem
            value="domains"
            label="domains"
            description="Verified destinations, plus any address on these domains. Addresses on the platform's own mail domain stay verified-destination-only."
          />
          <RadioListItem
            value="any"
            label="any"
            description="Every recipient; addresses on the platform's own mail domain stay verified-destination-only, so no project reaches another project's inbox without its consent."
          />
        </RadioList>
        <FormTextArea
          label="Allowed domains"
          name="domains"
          initialValue={policy.domains.join('\n')}
          rows={3}
          width={360}
          placeholder="example.com, corp.example.net"
        />
        <Button type="submit" label="Save policy" />
      </form>
      <p style={META}>
        With <code>domains</code> or <code>any</code>, Cloudflare still refuses a destination it has
        not verified unless the platform mail domain is onboarded for Email Sending (Workers Paid).
        Those refusals arrive as per-recipient <code>UNVERIFIED_DESTINATION</code> results.
      </p>

      <h2>Domain management</h2>
      <p>Who registers custom email domains for projects.</p>
      <form method="post" action="/admin/email/settings" className="void-admin-email-choice-form">
        <RadioList
          label="Domain management"
          isLabelHidden
          size="sm"
          htmlName="domains"
          value={domainManagement}
          onChange={(value: string) => setDomainManagement(value as EmailDomainManagement)}
        >
          <RadioListItem
            value="self-serve"
            label="self-serve"
            description="Project owners grant a Cloudflare credential from void email domain add."
          />
          <RadioListItem
            value="admin"
            label="admin"
            description="Administrators add domains; void email domain add prints the administrator's command instead."
          />
        </RadioList>
        <Button type="submit" label="Save" />
      </form>
    </Layout>
  );
}
