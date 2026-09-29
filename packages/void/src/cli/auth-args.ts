import type { SubcommandDef } from './subcommand-prompt.ts';

export const authSubcommands: Array<SubcommandDef> = [
  { name: 'login', description: 'Sign in to the selected deployment destination' },
  { name: 'status', description: 'Show the selected destination’s signed-in identity' },
  { name: 'logout', description: 'Sign out of the selected deployment destination' },
];

export type AuthArgs = {
  subcommand: 'login' | 'logout' | 'status' | 'whoami' | 'link' | 'token';
  platform?: 'cloudflare' | 'void';
  connectionId?: string;
};

export function parseAuthArgs(args: Array<string>): AuthArgs {
  const [subcommand, ...rest] = args;
  if (
    !subcommand ||
    !['login', 'logout', 'status', 'whoami', 'link', 'token'].includes(subcommand)
  ) {
    throw new Error('auth: Usage: void auth <login|status|logout> [--platform cloudflare|void].');
  }
  let platform: AuthArgs['platform'];
  let connectionId: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (value === '--platform') {
      const target = rest[++index];
      if (target !== 'cloudflare' && target !== 'void') {
        throw new Error('auth: --platform must be cloudflare or void.');
      }
      if (platform) {
        throw new Error('auth: --platform may be supplied only once.');
      }
      platform = target;
    } else if (subcommand === 'link' && !connectionId && /^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
      connectionId = value;
    } else {
      throw new Error(`auth: Unexpected argument '${value}'.`);
    }
  }
  if ((subcommand === 'link' || subcommand === 'token') && platform === 'cloudflare') {
    throw new Error(
      `auth: ${subcommand} belongs to a Void account. Use \`void account ${subcommand}\`.`,
    );
  }
  return {
    subcommand: subcommand as AuthArgs['subcommand'],
    ...(platform ? { platform } : {}),
    ...(connectionId ? { connectionId } : {}),
  };
}
