import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectPrerenderPathsNode } from '../../src/prerender';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/node-static';
const DIST = join(ROOT, PLAYGROUND, 'dist');

describe('playground/node-static build (target: node, output: static)', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
  }, 120_000);

  it('emits Node SSR entry', () => {
    expect(existsSync(join(DIST, 'ssr/app.js'))).toBe(true);
  });

  it('prerenders index.html with production asset URLs', () => {
    const indexPath = join(DIST, 'client/index.html');
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="home-title"');
    expect(html).toContain('Home');

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/@id/');
  });

  it('proves rendering happened in Node.js via process.versions.node', () => {
    const html = readFileSync(join(DIST, 'client/index.html'), 'utf-8');
    const match = html.match(/data-testid="runtime"[^>]*>([^<]+)</);
    expect(match).not.toBeNull();
    // Node.js version string like "24.13.1"
    expect(match![1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prerenders about.html with production asset URLs', () => {
    const aboutPath = join(DIST, 'client/about.html');
    expect(existsSync(aboutPath)).toBe(true);

    const html = readFileSync(aboutPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="about-title"');
    expect(html).toContain('About');

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/@id/');
  });

  it('collects prerender paths from the built node app endpoint', async () => {
    const paths = await collectPrerenderPathsNode({
      root: join(ROOT, PLAYGROUND),
      ssrDir: join(DIST, 'ssr'),
      clientDir: join(DIST, 'client'),
    });

    expect(paths).toEqual(expect.arrayContaining(['/', '/about']));
  });

  it('does not emit wrangler.json (Node target)', () => {
    expect(existsSync(join(DIST, 'ssr/wrangler.json'))).toBe(false);
    expect(existsSync(join(DIST, 'ssr/wrangler.jsonc'))).toBe(false);
  });
}, 120_000);
