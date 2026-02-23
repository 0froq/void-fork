import { defineHandler } from "void";

export interface Props {
  githubUrl: string;
  googleUrl: string;
}

export const loader = defineHandler<Props>((c) => {
  const platformUrl = (c.env as Record<string, string>).API_URL ?? "https://api.void.cloud";

  // Derive origin from Host header — c.req.url can be localhost in prod
  // due to Workers Assets internal dispatch
  const host = c.req.header("host")!;
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const callbackUrl = `${protocol}://${host}/auth/callback`;

  const githubUrl = `${platformUrl}/auth/login?provider=github&redirect=${encodeURIComponent(callbackUrl)}`;
  const googleUrl = `${platformUrl}/auth/login?provider=google&redirect=${encodeURIComponent(callbackUrl)}`;

  return { githubUrl, googleUrl };
});
