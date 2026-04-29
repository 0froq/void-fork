import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import type { UsageEvent } from '../../src/usage-counter.ts';
import { groupEventsByUser } from '../../src/usage-queue.ts';

describe('groupEventsByUser', () => {
  it('groups events by userId', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u2', slug: 's2', requests: 1, responseBytes: 200 },
      { projectId: 'p3', userId: 'u1', slug: 's3', requests: 1, responseBytes: 300 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get('u1')).toHaveLength(2);
    expect(grouped.get('u2')).toHaveLength(1);
  });

  it('returns empty map for empty events', () => {
    const grouped = groupEventsByUser([]);
    expect(grouped.size).toBe(0);
  });

  it('handles single user with multiple events', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u1', slug: 's2', requests: 1, responseBytes: 200 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(1);
    expect(grouped.get('u1')).toHaveLength(2);
  });
});
