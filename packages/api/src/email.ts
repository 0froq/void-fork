const SENDER = "Void <noreply@void.cloud>";

export async function sendInvitationEmail(
  emailBinding: SendEmail,
  to: string,
  inviteUrl: string,
): Promise<void> {
  await emailBinding.send({
    from: SENDER,
    to,
    subject: "You're invited to Void",
    html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;color:#1a1a1a">
<h2 style="margin-bottom:8px">You're invited to Void</h2>
<p>You've been invited to join <strong>Void</strong> — the deployment platform for the Vite ecosystem.</p>
<p><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#000;color:#fff;padding:10px 24px;text-decoration:none;border-radius:4px;font-weight:500">Get Started</a></p>
<p style="color:#666;font-size:0.85rem;margin-top:24px">If you didn't expect this invitation, you can ignore this email.</p>
</body></html>`,
    text: `You're invited to Void\n\nYou've been invited to join Void — the deployment platform for the Vite ecosystem.\n\nGet started: ${inviteUrl}\n\nIf you didn't expect this invitation, you can ignore this email.`,
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
