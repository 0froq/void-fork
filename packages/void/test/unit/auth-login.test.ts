import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runLogin } from '../../src/cli/auth.ts';

const mockExec = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (...args: Array<unknown>) => mockExec(...args),
}));

beforeEach(() => {
  mockExec.mockReset();
});

describe('runLogin', () => {
  it('binds the localhost callback to the login request with state', async () => {
    let resolveLoginUrl!: (url: string) => void;
    const loginUrlPromise = new Promise<string>((resolve) => {
      resolveLoginUrl = resolve;
    });

    const loginPromise = runLogin('/project', 'github', resolveLoginUrl);
    const loginUrl = new URL(await loginUrlPromise);
    const redirect = loginUrl.searchParams.get('redirect');

    expect(redirect).toBeTruthy();
    expect(loginUrl.searchParams.has('state')).toBe(false);

    const redirectUrl = new URL(redirect!);
    const state = redirectUrl.searchParams.get('state');
    expect(state).toEqual(expect.any(String));
    expect(state).toHaveLength(64);

    const attackUrl = new URL(redirectUrl);
    attackUrl.searchParams.set('token', 'attacker-controlled-token');
    attackUrl.searchParams.set('state', 'wrong-state');

    const attackResponse = await fetch(attackUrl);
    expect(attackResponse.status).toBe(400);

    const validUrl = new URL(redirectUrl);
    validUrl.searchParams.set('token', 'real-token');

    const validResponse = await fetch(validUrl);
    expect(validResponse.status).toBe(200);
    await expect(loginPromise).resolves.toBe('real-token');
  });
});
