import type { PlatformArgs } from './platform-args.ts';

export async function runInstalledPlatformCommand(args: PlatformArgs): Promise<void> {
  throw new Error(`platform: ${args.subcommand} is not available in this build.`);
}
