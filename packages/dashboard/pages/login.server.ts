import apkProtocolMedium from '@voidcloud/ui/fonts/APK-Protocol-Medium.woff2';
import interRomanLatin from '@voidcloud/ui/fonts/inter-roman-latin.woff2';
import khTekaMonoRegular from '@voidcloud/ui/fonts/KHTekaMono-Regular.woff2';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { defineHandler, defineHead } from 'void';
import { getPublicApiUrl } from '../lib/api.ts';

export type Props = Readonly<{
  githubUrl: string;
  googleUrl: string;
}>;

export const head = defineHead<Props>(() => ({
  link: [
    { rel: 'preload', href: apkProtocolMedium, as: 'font', type: 'font/woff2', crossorigin: '' },
    { rel: 'preload', href: interRomanLatin, as: 'font', type: 'font/woff2', crossorigin: '' },
    { rel: 'preload', href: khTekaMonoRegular, as: 'font', type: 'font/woff2', crossorigin: '' },
  ],
}));

export const loader = defineHandler<Props>((c) => {
  const platformUrl = getPublicApiUrl(c);

  // Derive origin from Host header — c.req.url can be localhost in prod
  // due to Workers Assets internal dispatch
  const host = c.req.header('host')!;
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  const protocol = isLocal ? 'http' : 'https';
  const callbackUrl = `${protocol}://${host}/auth/callback`;

  // Bind the OAuth callback to this browser session to prevent login CSRF.
  // The nonce is included in both a cookie and the redirect URL. The callback
  // verifies the cookie value matches the URL param — an attacker's crafted
  // callback URL won't match the victim's cookie.
  const nonce = getCookie(c, 'void_auth_nonce') ?? crypto.randomUUID();
  setCookie(c, 'void_auth_nonce', nonce, {
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'Lax',
    path: '/',
    maxAge: 300,
  });
  deleteCookie(c, 'void_auth_nonce', { path: '/auth' });

  const callbackWithNonce = `${callbackUrl}?login_nonce=${nonce}`;
  const githubUrl = `${platformUrl}/auth/login?provider=github&redirect=${encodeURIComponent(callbackWithNonce)}`;
  const googleUrl = `${platformUrl}/auth/login?provider=google&redirect=${encodeURIComponent(callbackWithNonce)}`;

  return { githubUrl, googleUrl };
});
