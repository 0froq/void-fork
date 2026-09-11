import { describe, expect, it } from 'vite-plus/test';
import { createDeployResourcePlan, type DeployManifest } from '../../src/index.ts';

describe('createDeployResourcePlan', () => {
  it('normalizes provisionable manifest resources without provider details', () => {
    const manifest: DeployManifest = {
      version: 3,
      bindings: {
        d1: ['DB'],
        kv: ['KV', 'ISR_CACHE'],
        r2: ['STORAGE'],
        ai: true,
        hyperdrive: ['HYPERDRIVE'],
      },
      queues: [
        {
          name: 'emails',
          bindingName: 'QUEUE_EMAILS',
          maxBatchSize: 10,
          maxRetries: 3,
        },
      ],
    };

    expect(createDeployResourcePlan(manifest)).toEqual({
      resources: [
        { type: 'd1', bindingName: 'DB' },
        { type: 'kv', bindingName: 'KV' },
        { type: 'kv', bindingName: 'ISR_CACHE' },
        { type: 'r2', bindingName: 'STORAGE' },
        {
          type: 'queue',
          bindingName: 'QUEUE_EMAILS',
          resourceName: 'emails',
          consumer: manifest.queues![0],
        },
        { type: 'hyperdrive', bindingName: 'HYPERDRIVE' },
      ],
    });
  });

  it('returns an empty plan when no provisionable resources are requested', () => {
    const manifest: DeployManifest = { version: 3, bindings: { ai: true } };

    expect(createDeployResourcePlan(manifest)).toEqual({ resources: [] });
  });
});
