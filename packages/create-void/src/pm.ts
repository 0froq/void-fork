import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'pathslash';

export type PM = 'npm' | 'pnpm' | 'yarn' | 'bun';

export const VOID_PNPM_ALLOWED_BUILDS = ['better-sqlite3', 'esbuild', 'sharp', 'workerd'] as const;

/** Write the explicit build-script policy required by a new pnpm project. */
export function writePnpmBuildPolicy(root: string, pm: PM): void {
  if (pm !== 'pnpm') {
    return;
  }
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    `allowBuilds:\n${VOID_PNPM_ALLOWED_BUILDS.map((name) => `  ${name}: true`).join('\n')}\n`,
  );
}

export function detectPM(): PM {
  const agent = process.env.npm_config_user_agent;
  if (agent) {
    if (agent.startsWith('pnpm/')) {
      return 'pnpm';
    }
    if (agent.startsWith('yarn/')) {
      return 'yarn';
    }
    if (agent.startsWith('bun/')) {
      return 'bun';
    }
  }
  return 'npm';
}

export function pmInstall(pm: PM): ReadonlyArray<string> {
  return [pm, 'install'];
}

export function pmExec(pm: PM): ReadonlyArray<string> {
  switch (pm) {
    case 'npm':
      return ['npx'];
    case 'pnpm':
      return ['pnpm', 'exec'];
    case 'yarn':
      return ['yarn', 'exec'];
    case 'bun':
      return ['bunx'];
  }
}

export function run(argv: ReadonlyArray<string>, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    // On Windows the package-manager entry points (npm, npx, pnpm, yarn, bunx)
    // are .cmd/.ps1 shims that spawn() cannot resolve without a shell, so it
    // throws ENOENT. Enable a shell only on win32; every arg here is a fixed
    // literal (no user input reaches argv), so there is no injection surface.
    const child = spawn(cmd, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`create-void: '${cmd}' exited with code ${code}.`));
      }
    });
    child.on('error', reject);
  });
}
