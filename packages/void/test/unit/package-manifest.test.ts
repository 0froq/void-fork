import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'pathe';
import { describe, expect, it } from 'vite-plus/test';

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const root = join(import.meta.dirname, '../../../..');

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const packageRoots = [
  '',
  'docs',
  ...readdirSync(join(root, 'packages')).map((name) => `packages/${name}`),
  ...readdirSync(join(root, 'playground')).map((name) => `playground/${name}`),
].filter((packageRoot) => existsSync(join(root, packageRoot, 'package.json')));

const readPackageJson = (packageDir: string): PackageJson =>
  JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf-8')) as PackageJson;

const packages = packageRoots.map((packageRoot) => ({
  manifest: readPackageJson(packageRoot),
  packageRoot: packageRoot || '.',
}));

const workspacePackageNames = new Set(
  packages.map(({ manifest }) => manifest.name).filter((name) => name != null),
);

const pnpmWorkspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8');

const readTopLevelScalar = (key: string) => {
  const match = new RegExp(`^${key}:\\s*(\\S+)`, 'm').exec(pnpmWorkspace);
  return match?.[1];
};

const readYamlSectionKeys = (sectionName: string) => {
  const lines = pnpmWorkspace.split('\n');
  const start = lines.indexOf(`${sectionName}:`);
  if (start === -1) {
    return new Set<string>();
  }

  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(' ')) {
      break;
    }

    const match = /^ {2}(?:"([^"]+)"|'([^']+)'|([^:#]+)):/u.exec(line);
    if (match) {
      keys.add(match[1] ?? match[2] ?? match[3].trim());
    }
  }
  return keys;
};

const catalogPackageNames = readYamlSectionKeys('catalog');

describe('package manifests', () => {
  it('uses workspace:* for local workspace package dependencies', () => {
    const violations = [];

    for (const { manifest, packageRoot } of packages) {
      for (const field of dependencyFields) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (workspacePackageNames.has(name) && specifier !== 'workspace:*') {
            violations.push(`${packageRoot} ${field}.${name} = ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('uses catalog: for dependencies managed by the default pnpm catalog', () => {
    const violations = [];

    for (const { manifest, packageRoot } of packages) {
      for (const field of dependencyFields) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (catalogPackageNames.has(name) && specifier !== 'catalog:') {
            violations.push(`${packageRoot} ${field}.${name} = ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('only uses catalog: for packages declared in the default pnpm catalog', () => {
    const violations = [];

    for (const { manifest, packageRoot } of packages) {
      for (const field of dependencyFields) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (specifier === 'catalog:' && !catalogPackageNames.has(name)) {
            violations.push(`${packageRoot} ${field}.${name}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps pnpm catalog additions strict', () => {
    expect(readTopLevelScalar('catalogMode')).toBe('strict');
  });
});
