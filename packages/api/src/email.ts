const SENDER = 'Void <noreply@void.cloud>';

const BUTTON_STYLE =
  'display:inline-block;background:#000;color:#fff;padding:10px 24px;text-decoration:none;border-radius:4px;font-weight:500';

function emailHtml(body: string, footer: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;color:#1a1a1a">
${body}
<p style="color:#666;font-size:0.85rem;margin-top:24px">${footer}</p>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="${BUTTON_STYLE}">${escapeHtml(label)}</a>`;
}

async function sendEmail(
  binding: SendEmail,
  params: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  await binding.send({ from: SENDER, ...params });
}

export async function sendInvitationEmail(
  emailBinding: SendEmail,
  to: string,
  inviteUrl: string,
): Promise<void> {
  await sendEmail(emailBinding, {
    to,
    subject: "You're invited to Void",
    html: emailHtml(
      `<h2 style="margin-bottom:8px">You're invited to Void</h2>
<p>You've been invited to join <strong>Void</strong> — the deployment platform for the Vite ecosystem.</p>
<p>${button(inviteUrl, 'Get Started')}</p>`,
      "If you didn't expect this invitation, you can ignore this email.",
    ),
    text: `You're invited to Void\n\nYou've been invited to join Void — the deployment platform for the Vite ecosystem.\n\nGet started: ${inviteUrl}\n\nIf you didn't expect this invitation, you can ignore this email.`,
  });
}

const GITHUB_SETUP_URL = 'https://github.com/void-sdk/void';
const DISCORD_URL = 'https://discord.gg/AxmAk8PffV';

export async function sendWelcomeEmail(
  emailBinding: SendEmail,
  to: string,
  login: string,
): Promise<void> {
  await sendEmail(emailBinding, {
    to,
    subject: 'Welcome to Void',
    html: emailHtml(
      `<h2 style="margin-bottom:8px">Welcome to Void, ${escapeHtml(login)}</h2>
<p>Your account is ready. Void is the deployment platform for the Vite ecosystem — deploy full-stack apps with file-based routing, database bindings, AI integration, and edge-first infrastructure.</p>
<p>Join our Discord to get an early-access feedback role and chat with the team:</p>
<p>${button(DISCORD_URL, 'Join Discord')}</p>
<p style="margin-top:16px">To install Void, you'll need to set up GitHub Packages access — see the <a href="${GITHUB_SETUP_URL}" style="color:#1a1a1a">setup instructions</a>.</p>`,
      'You received this email because you signed up for Void.',
    ),
    text: `Welcome to Void, ${login}\n\nYour account is ready. Void is the deployment platform for the Vite ecosystem — deploy full-stack apps with file-based routing, database bindings, AI integration, and edge-first infrastructure.\n\nJoin our Discord to get an early-access feedback role and chat with the team: ${DISCORD_URL}\n\nTo install Void, you'll need to set up GitHub Packages access — setup instructions: ${GITHUB_SETUP_URL}\n\nYou received this email because you signed up for Void.`,
  });
}

export async function sendDeployFailedEmail(
  emailBinding: SendEmail,
  to: string,
  projectSlug: string,
  errorMessage: string,
  dashboardUrl: string,
): Promise<void> {
  const truncated = errorMessage.length > 200 ? errorMessage.slice(0, 200) + '...' : errorMessage;
  const projectUrl = `${dashboardUrl}/projects/${encodeURIComponent(projectSlug)}`;

  await sendEmail(emailBinding, {
    to,
    subject: `Deploy failed: ${projectSlug}`,
    html: emailHtml(
      `<h2 style="margin-bottom:8px">Deploy failed: ${escapeHtml(projectSlug)}</h2>
<p>A deploy to <strong>${escapeHtml(projectSlug)}</strong> failed with the following error:</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;font-size:0.85rem">${escapeHtml(truncated)}</pre>
<p>${button(projectUrl, 'View Project')}</p>`,
      'You received this email because you own this project on Void.',
    ),
    text: `Deploy failed: ${projectSlug}\n\nA deploy to ${projectSlug} failed with the following error:\n\n${truncated}\n\nView project: ${projectUrl}\n\nYou received this email because you own this project on Void.`,
  });
}

export async function sendErrorAlertEmail(
  emailBinding: SendEmail,
  to: string,
  projectSlug: string,
  errorCount: number,
  dashboardUrl: string,
): Promise<void> {
  const projectUrl = `${dashboardUrl}/projects/${encodeURIComponent(projectSlug)}`;

  await sendEmail(emailBinding, {
    to,
    subject: `5xx errors detected: ${projectSlug}`,
    html: emailHtml(
      `<h2 style="margin-bottom:8px">5xx errors detected: ${escapeHtml(projectSlug)}</h2>
<p>Your project <strong>${escapeHtml(projectSlug)}</strong> has returned <strong>${errorCount}</strong> server error responses recently.</p>
<p>${button(projectUrl, 'View Project')}</p>`,
      'You will not receive another alert for this project for 24 hours. You received this email because you own this project on Void.',
    ),
    text: `5xx errors detected: ${projectSlug}\n\nYour project ${projectSlug} has returned ${errorCount} server error responses recently.\n\nView project: ${projectUrl}\n\nYou will not receive another alert for this project for 24 hours. You received this email because you own this project on Void.`,
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
