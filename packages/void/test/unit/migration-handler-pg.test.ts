import { describe, expect, it } from 'vite-plus/test';
import { disablePgPassFallback } from '../../src/runtime/migration-handler-pg.ts';

describe('PostgreSQL migration handler', () => {
  it('prevents pgpass fallback when Hyperdrive connection strings have no password', () => {
    const client: {
      connectionParameters: { password: unknown };
      password: unknown;
    } = {
      connectionParameters: { password: null },
      password: null,
    };

    disablePgPassFallback(client);

    expect(typeof client.password).toBe('function');
    expect(client.connectionParameters.password).toBe(client.password);
  });

  it('keeps parsed connection string passwords intact', () => {
    const client = {
      connectionParameters: { password: 'secret' },
      password: 'secret',
    };

    disablePgPassFallback(client);

    expect(client.password).toBe('secret');
    expect(client.connectionParameters.password).toBe('secret');
  });
});
