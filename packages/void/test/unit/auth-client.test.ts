import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { createAuthClientMock } = vi.hoisted(() => ({
  createAuthClientMock: vi.fn((options?: unknown) => ({ options })),
}));

vi.mock('better-auth/client', () => ({
  createAuthClient: createAuthClientMock,
}));

beforeEach(() => {
  vi.resetModules();
});

describe('auth-client runtime', () => {
  it("re-exports Better Auth's createAuthClient", async () => {
    const { createAuthClient } = await import('../../src/runtime/auth-client.ts');
    expect(createAuthClient).toBe(createAuthClientMock);
  });

  it("creates the default auth client with Void's base path", async () => {
    const { auth } = await import('../../src/runtime/auth-client.ts');
    expect(createAuthClientMock).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(auth).toEqual({ options: { basePath: '/api/auth' } });
  });
});
