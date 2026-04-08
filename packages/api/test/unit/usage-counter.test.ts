import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import { evaluateRequestLimit, evaluateAiLimit, type CounterState } from '../../src/usage-counter';

function makeState(overrides: Partial<CounterState> = {}): CounterState {
  return {
    totalRequests: 0,
    totalNeurons: 0,
    plan: 'free',
    billingPeriodStart: '2026-01-01T00:00:00Z',
    requestsSuspended: false,
    aiSuspended: false,
    projectSlugs: {},
    ...overrides,
  };
}

describe('evaluateRequestLimit', () => {
  it('returns false when within free plan limit (3M)', () => {
    const state = makeState({ totalRequests: 1_000_000, plan: 'free' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);
  });

  it('returns true when exceeding free plan limit', () => {
    const state = makeState({ totalRequests: 2_999_999, plan: 'free' });
    expect(evaluateRequestLimit(state, 2)).toBe(true);
  });

  it('returns true when exactly at free plan limit', () => {
    const state = makeState({ totalRequests: 2_999_990, plan: 'free' });
    expect(evaluateRequestLimit(state, 10)).toBe(true);
  });

  it('returns false for unlimited plans (sponsored)', () => {
    const state = makeState({ totalRequests: 999_999_999, plan: 'sponsored' });
    expect(evaluateRequestLimit(state, 1_000_000)).toBe(false);
  });

  it('returns false for unlimited plans (custom)', () => {
    const state = makeState({ totalRequests: 999_999_999, plan: 'custom' });
    expect(evaluateRequestLimit(state, 1_000_000)).toBe(false);
  });

  it('works for solo plan (10M limit)', () => {
    const state = makeState({ totalRequests: 5_000_000, plan: 'solo' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);

    const atLimit = makeState({ totalRequests: 9_999_999, plan: 'solo' });
    expect(evaluateRequestLimit(atLimit, 2)).toBe(true);
  });

  it('works for pro plan (100M limit)', () => {
    const state = makeState({ totalRequests: 50_000_000, plan: 'pro' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);

    const atLimit = makeState({ totalRequests: 99_999_999, plan: 'pro' });
    expect(evaluateRequestLimit(atLimit, 2)).toBe(true);
  });
});

describe('evaluateAiLimit', () => {
  it('returns true when free plan exceeds 100K neurons', () => {
    const state = makeState({ totalNeurons: 100_001, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when free plan is exactly at 100K neurons', () => {
    const state = makeState({ totalNeurons: 100_000, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when solo plan exceeds 300K neurons', () => {
    const state = makeState({ totalNeurons: 300_001, plan: 'solo' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when pro plan exceeds 500K neurons', () => {
    const state = makeState({ totalNeurons: 500_001, plan: 'pro' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns false for unlimited plans (sponsored)', () => {
    const state = makeState({ totalNeurons: 999_999_999, plan: 'sponsored' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false for unlimited plans (custom)', () => {
    const state = makeState({ totalNeurons: 999_999_999, plan: 'custom' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within free plan limits', () => {
    const state = makeState({ totalNeurons: 50_000, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within solo plan limits', () => {
    const state = makeState({ totalNeurons: 200_000, plan: 'solo' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within pro plan limits', () => {
    const state = makeState({ totalNeurons: 400_000, plan: 'pro' });
    expect(evaluateAiLimit(state)).toBe(false);
  });
});
