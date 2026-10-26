import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { pagesPlugin } from '../../src/plugin-pages.ts';

const TMP = join(import.meta.dirname, '__tmp_pages_plugin__');
const PAGES_DIR = join(TMP, 'pages');

type HookWithHandler<T> = { handler: T };
type PagesPluginHooks = {
  buildStart?: (() => Promise<void>) | HookWithHandler<() => Promise<void>>;
  configureServer?: (server: unknown) => void;
  config?:
    | ((config: Record<string, unknown>, env: { command: 'serve' | 'build' }) => unknown)
    | HookWithHandler<
        (config: Record<string, unknown>, env: { command: 'serve' | 'build' }) => unknown
      >;
  load?:
    | ((id: string) => Promise<string | undefined> | string | undefined)
    | HookWithHandler<(id: string) => Promise<string | undefined> | string | undefined>;
};

function getHookHandler<T>(hook: T | HookWithHandler<T> | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

function writePage(relativePath: string, source: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, source);
}

type PatchProps = (comp: Record<string, unknown>, props: Record<string, unknown>) => void;

function extractPatchProps(moduleSource: string): PatchProps {
  const marker = 'function hasRuntimePropsDeclaration';
  const start = moduleSource.indexOf(marker);
  if (start === -1) {
    throw new Error('Expected patchProps runtime in generated module.');
  }
  const afterPatchProps = moduleSource.indexOf('function replaceRecord', start);
  const exportRender = moduleSource.indexOf('export async function renderPage', start);
  const end = afterPatchProps === -1 ? exportRender : afterPatchProps;
  if (end === -1) {
    throw new Error('Expected patchProps runtime boundary in generated module.');
  }
  const block = moduleSource.slice(start, end);
  return new Function(`${block}; return patchProps;`)() as PatchProps;
}

async function loadGeneratedPatchProps(
  plugin: PagesPluginHooks,
  virtualId: '\0virtual:void-pages-renderer' | '\0virtual:void-pages-client',
): Promise<PatchProps> {
  getHookHandler(plugin.config)({}, { command: 'build' });
  await getHookHandler(plugin.buildStart).call({});
  const source = await getHookHandler(plugin.load)(virtualId);
  if (!source) {
    throw new Error(`Expected generated module for ${virtualId}.`);
  }
  return extractPatchProps(source);
}

function setupWatcher(plugin: PagesPluginHooks, logError = vi.fn(), invalidateModule = vi.fn()) {
  const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
  plugin.configureServer?.({
    watcher: {
      on(event: string, handler: (path: string) => Promise<void> | void) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
    },
    environments: {
      client: { moduleGraph: { getModuleById: (id: string) => ({ id }), invalidateModule } },
    },
    config: { logger: { error: logError } },
  });
  return handlers;
}

describe('pagesPlugin generated patchProps', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('preserves runtime object props declarations in SSR and client bundles', async () => {
    writePage('index.vue', '<template><h1>Home</h1></template>\n');

    const plugin = pagesPlugin(PAGES_DIR).find((p) => p.name === 'void-vue:pages') as
      | PagesPluginHooks
      | undefined;
    if (!plugin) {
      throw new Error('Expected void-vue:pages plugin.');
    }

    const rendererPatchProps = await loadGeneratedPatchProps(
      plugin,
      '\0virtual:void-pages-renderer',
    );
    const clientPatchProps = await loadGeneratedPatchProps(plugin, '\0virtual:void-pages-client');

    const declared = {
      title: { type: String, default: 'DEFAULT' },
      count: { type: Number, required: true },
    };
    const comp: Record<string, unknown> = { props: { ...declared } };

    rendererPatchProps(comp, { count: -1 });
    expect(comp.props).toEqual(declared);
    expect(comp.__voidPatched).toBeUndefined();

    clientPatchProps(comp, { count: -1 });
    expect(comp.props).toEqual(declared);
    expect(comp.__voidPatched).toBeUndefined();
  });

  it('registers prop keys when the component has no runtime props declaration', async () => {
    writePage('index.vue', '<template><h1>Home</h1></template>\n');

    const plugin = pagesPlugin(PAGES_DIR).find((p) => p.name === 'void-vue:pages') as
      | PagesPluginHooks
      | undefined;
    if (!plugin) {
      throw new Error('Expected void-vue:pages plugin.');
    }

    const patchProps = await loadGeneratedPatchProps(plugin, '\0virtual:void-pages-renderer');
    const comp: Record<string, unknown> = {};

    patchProps(comp, { count: 1, title: 'hi' });
    expect(comp.props).toEqual(['count', 'title']);
    expect(comp.__voidPatched).toBe(true);
  });
});

describe('pagesPlugin dev HMR', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('rescans dev renderer loads after adding a page file', async () => {
    writePage('index.vue', '<template><h1>Home</h1></template>\n');

    const plugin = pagesPlugin(PAGES_DIR).find((p) => p.name === 'void-vue:pages') as
      | PagesPluginHooks
      | undefined;
    if (!plugin) {
      throw new Error('Expected void-vue:pages plugin.');
    }
    getHookHandler(plugin.config)({}, { command: 'serve' });
    await getHookHandler(plugin.buildStart).call({});
    const handlers = setupWatcher(plugin);

    writePage('test.vue', '<template><h1>Test</h1></template>\n');
    for (const handler of handlers.get('add') ?? []) {
      await handler(join(PAGES_DIR, 'test.vue'));
    }

    const load = getHookHandler(plugin.load);
    const renderer = await load('\0virtual:void-pages-renderer');

    expect(renderer).toContain('["test", () => import');
  });

  it('logs a page scan error from the watcher and keeps the last scan', async () => {
    writePage('index.vue', '<template><h1>Home</h1></template>\n');

    const plugin = pagesPlugin(PAGES_DIR).find((p) => p.name === 'void-vue:pages') as
      | PagesPluginHooks
      | undefined;
    if (!plugin) {
      throw new Error('Expected void-vue:pages plugin.');
    }
    getHookHandler(plugin.config)({}, { command: 'serve' });
    await getHookHandler(plugin.buildStart).call({});
    const logError = vi.fn();
    const invalidateModule = vi.fn();
    const handlers = setupWatcher(plugin, logError, invalidateModule);
    const emitAdd = async (relativePath: string) => {
      for (const handler of handlers.get('add') ?? []) {
        await expect(handler(join(PAGES_DIR, relativePath))).resolves.toBeUndefined();
      }
    };

    writePage('about.md', '---\nlayout: docs\n---\n# About\n');
    await emitAdd('about.md');

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toContain("specifies layout 'docs'");
    expect(invalidateModule).not.toHaveBeenCalled();
    const renderer = await getHookHandler(plugin.load)('\0virtual:void-pages-renderer');
    expect(renderer).toContain('["index", () => import');
    expect(renderer).not.toContain('"about"');

    writePage('_layouts/docs.vue', '<template><main><slot /></main></template>\n');
    await emitAdd('_layouts/docs.vue');

    expect(logError).toHaveBeenCalledTimes(1);
    expect(invalidateModule).toHaveBeenCalled();
    const recovered = await getHookHandler(plugin.load)('\0virtual:void-pages-renderer');
    expect(recovered).toContain('"about"');
  });
});
