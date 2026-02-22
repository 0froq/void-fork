import { defineHandler } from "vite-cloud";

export interface Props {
  githubUrl: string;
  googleUrl: string;
}

export const loader = defineHandler<Props>((c) => {
  const platformUrl =
    (c.env as Record<string, string>).PLATFORM_API_URL ?? "https://platform.vite.cloud";

  // In local dev, redirect back to localhost; in prod, to the dashboard domain
  const requestUrl = new URL(c.req.url);
  const callbackUrl = `${requestUrl.origin}/auth/callback`;

  const githubUrl = `${platformUrl}/auth/login?provider=github&redirect=${encodeURIComponent(callbackUrl)}`;
  const googleUrl = `${platformUrl}/auth/login?provider=google&redirect=${encodeURIComponent(callbackUrl)}`;

  return { githubUrl, googleUrl };
});
