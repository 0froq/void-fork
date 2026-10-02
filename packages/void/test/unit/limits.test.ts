import { describe, expect, it, vi } from 'vite-plus/test';
import { limitOperation, UsageLimit, limitFromResponse } from '../../src/runtime/limits.ts';

describe('mandatory limit handling', () => {
  it('does not execute until both handlers are supplied, and executes only once', async () => {
    const execute = vi.fn(async () => 42);
    const op = limitOperation(execute);
    expect(execute).not.toHaveBeenCalled();
    await expect(op.match({ ok: String } as never)).rejects.toThrow('Both');
    expect(execute).not.toHaveBeenCalled();
    const handlers = { ok: String, limited: () => 'unavailable' };
    expect(await op.match(handlers)).toBe('42');
    expect(await op.match(handlers)).toBe('42');
    expect(execute).toHaveBeenCalledOnce();
    await expect(async () => {
      await op;
    }).rejects.toThrow('Use .match');
  });
  it('routes quota failures only, without swallowing failures from the success handler', async () => {
    const limit = new UsageLimit({
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'No allowance',
    });
    expect(
      await limitOperation(async () => {
        throw limit;
      }).match({ ok: String, limited: (l) => l.message }),
    ).toBe('No allowance');
    const limited = vi.fn();
    await expect(
      limitOperation(async () => 1).match({
        ok: () => {
          throw limit;
        },
        limited,
      }),
    ).rejects.toBe(limit);
    expect(limited).not.toHaveBeenCalled();
    await expect(
      limitOperation(async () => {
        throw new Error('network');
      }).match({ ok: String, limited }),
    ).rejects.toThrow('network');
  });
  it('preserves structured limits and retry metadata in public responses', async () => {
    const limit = new UsageLimit({
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'No allowance',
      retryAt: '2099-01-01T00:00:00.000Z',
    });
    const response = limit.response({ message: 'Try again next month' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(await limitFromResponse(response, 'ai')).toMatchObject({
      reason: 'monthly_quota',
      message: 'Try again next month',
      retryAt: limit.retryAt,
    });
  });
});
