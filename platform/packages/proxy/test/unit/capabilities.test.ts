import { describe, expect, it } from 'vite-plus/test';
import { proxyCapabilityEnabled } from '../../src/capabilities.ts';

describe('proxy capabilities', () => {
  it('keeps the legacy tenant-controlled Sandbox gate disabled when configuration is absent', () => {
    expect(proxyCapabilityEnabled(undefined, 'sandbox')).toBe(false);
  });

  it('overrides stale enablement for the legacy tenant-controlled Sandbox gate', () => {
    expect(proxyCapabilityEnabled('{"sandbox":true}', 'sandbox')).toBe(false);
  });
});
