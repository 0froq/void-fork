import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { DispatchTimeoutError, resolveTimeoutMs, withTimeout } from '../src/with-timeout.ts';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the same value on a fast resolve and clears the timer', async () => {
    const p = withTimeout(Promise.resolve('ok'), 1000, 'fast-resolve');

    await expect(p).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the ORIGINAL rejection on a fast reject and clears the timer', async () => {
    const original = new Error('boom');
    const p = withTimeout(Promise.reject(original), 1000, 'fast-reject');

    const caught = await p.catch((e: unknown) => e);
    expect(caught).toBe(original);
    expect(caught).not.toBeInstanceOf(DispatchTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with DispatchTimeoutError carrying the label when the timer wins', async () => {
    const neverSettles = new Promise<never>(() => {});
    const p = withTimeout(neverSettles, 1000, 'slow-op');
    // Attach the handler up front so the eventual rejection is never "unhandled".
    const caught = p.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1000);

    const err = await caught;
    expect(err).toBeInstanceOf(DispatchTimeoutError);
    expect((err as DispatchTimeoutError).label).toBe('slow-op');
    expect((err as DispatchTimeoutError).name).toBe('DispatchTimeoutError');
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('escape hatch (no timer scheduled)', () => {
    for (const ms of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      it(`returns the same promise instance for ms=${String(ms)}`, async () => {
        const inner = Promise.resolve('passthrough');
        const p = withTimeout(inner, ms, 'escape');

        expect(p).toBe(inner);
        expect(vi.getTimerCount()).toBe(0);
        await expect(p).resolves.toBe('passthrough');
        expect(vi.getTimerCount()).toBe(0);
      });
    }
  });

  it('resolves normally when the promise settles slightly before the deadline', async () => {
    const inner = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 999);
    });
    const p = withTimeout(inner, 1000, 'near-miss');

    await vi.advanceTimersByTimeAsync(999);

    await expect(p).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('resolveTimeoutMs', () => {
  it('returns the 10s default when the env var is unset', () => {
    expect(resolveTimeoutMs(undefined)).toBe(10000);
  });

  it('parses a valid numeric override', () => {
    expect(resolveTimeoutMs('5000')).toBe(5000);
  });

  it('passes an explicit "0" through (the disable escape hatch, not the default)', () => {
    expect(resolveTimeoutMs('0')).toBe(0);
  });

  it('treats an empty string as 0 (disabled)', () => {
    expect(resolveTimeoutMs('')).toBe(0);
  });

  it('passes a negative override through unchanged', () => {
    expect(resolveTimeoutMs('-5')).toBe(-5);
  });

  it('passes a non-numeric override through as NaN', () => {
    expect(Number.isNaN(resolveTimeoutMs('abc'))).toBe(true);
  });

  it('passes "Infinity" through as Infinity', () => {
    expect(resolveTimeoutMs('Infinity')).toBe(Number.POSITIVE_INFINITY);
  });

  describe('feeds withTimeout escape hatch (no timer scheduled)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('disables the timer for a "0" budget', async () => {
      const ms = resolveTimeoutMs('0');
      const p = withTimeout(Promise.resolve('x'), ms, 'off');

      await expect(p).resolves.toBe('x');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('disables the timer for a non-numeric (NaN) budget', async () => {
      const ms = resolveTimeoutMs('abc');
      const p = withTimeout(Promise.resolve('x'), ms, 'off');

      await expect(p).resolves.toBe('x');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
