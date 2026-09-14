import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'pathslash';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '..', '..');
const runtimeRoot = join(packageRoot, 'dist', 'runtime');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'void-platform-runtime-'));
const wrangler = fileURLToPath(import.meta.resolve('wrangler'));

const workers = [
  ['api', join(repositoryRoot, 'platform', 'packages', 'api', 'src', 'index.ts')],
  ['proxy', join(repositoryRoot, 'platform', 'packages', 'proxy', 'src', 'index.ts')],
  ['tail', join(repositoryRoot, 'platform', 'packages', 'tail', 'src', 'index.ts')],
  ['dispatch', join(repositoryRoot, 'platform', 'packages', 'dispatch', 'src', 'index.ts')],
];

try {
  rmSync(runtimeRoot, { force: true, recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const artifacts = {};

  for (const [name, entrypoint] of workers) {
    const configPath = join(temporaryRoot, `${name}.json`);
    const outputDirectory = join(runtimeRoot, name);
    writeFileSync(
      configPath,
      JSON.stringify({
        name: `void-runtime-build-${name}`,
        main: entrypoint,
        compatibility_date: '2026-02-24',
        compatibility_flags: name === 'api' || name === 'proxy' ? ['nodejs_compat'] : [],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [wrangler, 'deploy', '--dry-run', '--config', configPath, '--outdir', outputDirectory],
      { cwd: dirname(entrypoint), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`Failed to build the ${name} platform Worker.`);
    }
    const artifactPath = join(outputDirectory, 'index.js');
    const contents = readFileSync(artifactPath);
    artifacts[name] = {
      path: `${name}/index.js`,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: contents.byteLength,
    };
  }

  cpSync(
    join(repositoryRoot, 'platform', 'packages', 'api', 'drizzle'),
    join(runtimeRoot, 'drizzle'),
    { recursive: true },
  );
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  writeFileSync(
    join(runtimeRoot, 'manifest.json'),
    `${JSON.stringify({ artifacts, platformVersion: packageJson.version, schemaVersion: 1 }, null, 2)}\n`,
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
