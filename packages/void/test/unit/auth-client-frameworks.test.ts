import { describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  react: vi.fn((options?: unknown) => ({ framework: 'react', options })),
  solid: vi.fn((options?: unknown) => ({ framework: 'solid', options })),
  svelte: vi.fn((options?: unknown) => ({ framework: 'svelte', options })),
  vue: vi.fn((options?: unknown) => ({ framework: 'vue', options })),
}));

vi.mock('better-auth/react', () => ({
  createAuthClient: mocks.react,
}));

vi.mock('better-auth/vue', () => ({
  createAuthClient: mocks.vue,
}));

vi.mock('better-auth/svelte', () => ({
  createAuthClient: mocks.svelte,
}));

vi.mock('better-auth/solid', () => ({
  createAuthClient: mocks.solid,
}));

describe('framework-specific client runtimes', () => {
  it('re-exports the React Better Auth client', async () => {
    const { auth: reactAuth, createAuthClient: createReactAuthClient } =
      await import('../../src/runtime/client-react.ts');
    expect(createReactAuthClient).toBe(mocks.react);
    expect(mocks.react).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(reactAuth).toEqual({ framework: 'react', options: { basePath: '/api/auth' } });
  });

  it('re-exports the Vue Better Auth client', async () => {
    const { auth: vueAuth, createAuthClient: createVueAuthClient } =
      await import('../../src/runtime/client-vue.ts');
    expect(createVueAuthClient).toBe(mocks.vue);
    expect(mocks.vue).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(vueAuth).toEqual({ framework: 'vue', options: { basePath: '/api/auth' } });
  });

  it('re-exports the Svelte Better Auth client', async () => {
    const { auth: svelteAuth, createAuthClient: createSvelteAuthClient } =
      await import('../../src/runtime/client-svelte.ts');
    expect(createSvelteAuthClient).toBe(mocks.svelte);
    expect(mocks.svelte).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(svelteAuth).toEqual({ framework: 'svelte', options: { basePath: '/api/auth' } });
  });

  it('re-exports the Solid Better Auth client', async () => {
    const { auth: solidAuth, createAuthClient: createSolidAuthClient } =
      await import('../../src/runtime/client-solid.ts');
    expect(createSolidAuthClient).toBe(mocks.solid);
    expect(mocks.solid).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(solidAuth).toEqual({ framework: 'solid', options: { basePath: '/api/auth' } });
  });
});
