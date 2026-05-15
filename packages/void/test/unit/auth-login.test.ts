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
    const state = loginUrl.searchParams.get('state');

    expect(redirect).toBeTruthy();

    const attackUrl = new URL(redirect!);
    attackUrl.searchParams.set('token', 'attacker-controlled-token');
    attackUrl.searchParams.set('state', 'wrong-state');

    const attackResponse = await fetch(attackUrl);
    expect(attackResponse.status).toBe(400);

    expect(state).toEqual(expect.any(String));
    expect(state).toHaveLength(64);

    const validUrl = new URL(redirect!);
    validUrl.searchParams.set('token', 'real-token');
    validUrl.searchParams.set('state', state!);

    const validResponse = await fetch(validUrl);
    expect(validResponse.status).toBe(200);
    await expect(loginPromise).resolves.toBe('real-token');
  });
});
