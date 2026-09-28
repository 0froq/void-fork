import { join } from 'pathslash';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'navigation-fallback');
let server: ViteDevServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  server = await createServer({
    root: FIXTURE,
    configFile: false,
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  base = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

it('shows the destination fallback before page data resolves', async () => {
  const page = await browser.newPage();
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/dashboard', async (route) => {
    if (route.request().headers()['x-voidpages'] !== 'true') {
      await route.continue();
      return;
    }
    await responseGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true' },
      body: JSON.stringify({
        component: 'dashboard',
        props: {},
        params: {},
        shared: {},
        url: '/dashboard',
        errors: null,
      }),
    });
  });

  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor({ state: 'visible' });
    expect(await page.getByRole('heading', { name: 'Home' }).count()).toBe(0);
    releaseResponse();
    await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor({ state: 'visible' });
    expect(page.url()).toBe(new URL('/dashboard', base).href);
  } finally {
    releaseResponse();
    await page.close();
  }
});

it('restores the previous page when the destination request fails', async () => {
  const page = await browser.newPage();
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/dashboard', async (route) => {
    await responseGate;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true' },
      body: 'invalid json',
    });
  });

  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor({ state: 'visible' });
    releaseResponse();
    await page.getByRole('heading', { name: 'Home' }).waitFor({ state: 'visible' });
    expect(page.url()).toBe(base);
  } finally {
    releaseResponse();
    await page.close();
  }
});
