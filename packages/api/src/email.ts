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

export async function sendInvitationEmail(emailBinding: SendEmail, to: string): Promise<void> {
  await sendEmail(emailBinding, {
    to,
    subject: "You're invited to Void's Private Beta",
    html: emailHtml(
      `<h2 style="margin-bottom:8px">Hello there!</h2>
<p>You're invited to <strong>Void's Private Beta</strong> phase.</p>
<p><strong>Warning:</strong> Void is still a work in progress and things may change.</p>
<p>We'd love to get your feedback on how we can improve. There are two ways to share your thoughts:</p>
<ul>
<li>Join the <a href="${DISCORD_URL}" style="color:#1a1a1a">Void Discord server</a>, then write in the private feedback channel.</li>
<li>Create an issue in <a href="${GITHUB_REPO_URL}" style="color:#1a1a1a">void-sdk/void</a> after you receive the invite.</li>
</ul>
<p>Thank you!</p>
<p>Please authenticate with a GitHub or Google account that uses the same email address as this invite.</p>
<p>${button(QUICKSTART_URL, 'Get Started')}</p>`,
      "If you didn't expect this invitation, you can ignore this email.",
    ),
    text: `Hello there!\n\nYou're invited to Void's Private Beta phase.\n\nWarning: Void is still a work in progress and things may change.\n\nWe'd love to get your feedback on how we can improve. There are two ways to share your thoughts:\n\nJoin the Void Discord server: ${DISCORD_URL}. Then write in the private feedback channel.\n\nCreate an issue in ${GITHUB_REPO_URL} after you receive the invite.\n\nThank you!\n\nPlease authenticate with a GitHub or Google account that uses the same email address as this invite.\n\nGet started: ${QUICKSTART_URL}\n\nIf you didn't expect this invitation, you can ignore this email.`,
  });
}

const QUICKSTART_URL = 'https://void.cloud/guide/quickstart';
const GUIDE_URL = 'https://void.cloud/guide/';
const DISCORD_URL = 'https://discord.gg/QRF4nSvcQv';
const GITHUB_REPO_URL = 'https://github.com/void-sdk/void';

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
<p style="margin-top:16px">To get started with Void, see the <a href="${GUIDE_URL}" style="color:#1a1a1a">guide</a>.</p>`,
      'You received this email because you signed up for Void.',
    ),
    text: `Welcome to Void, ${login}\n\nYour account is ready. Void is the deployment platform for the Vite ecosystem — deploy full-stack apps with file-based routing, database bindings, AI integration, and edge-first infrastructure.\n\nJoin our Discord to get an early-access feedback role and chat with the team: ${DISCORD_URL}\n\nTo get started with Void, see the guide: ${GUIDE_URL}\n\nYou received this email because you signed up for Void.`,
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
