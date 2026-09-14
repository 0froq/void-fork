import { describe, expect, it } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';

describe('platform args', () => {
  it('parses connection and lifecycle selectors', () => {
    expect(parsePlatformArgs(['connect', 'https://api.example.com'])).toEqual({
      subcommand: 'connect',
      url: 'https://api.example.com',
    });
    expect(parsePlatformArgs(['repair', 'example-a1b2c3d4', '--plan'])).toEqual({
      subcommand: 'repair',
      selector: 'example-a1b2c3d4',
      plan: true,
    });
  });

  it('parses safe uninstall choices explicitly', () => {
    expect(parsePlatformArgs(['uninstall', '--purge-data', '--keep-zone'])).toEqual({
      subcommand: 'uninstall',
      selector: '',
      plan: false,
      purgeData: true,
      deleteZone: false,
    });
    expect(() => parsePlatformArgs(['uninstall', '--delete-zone', '--keep-zone'])).toThrow();
  });

  it('parses a non-interactive installation', () => {
    expect(
      parsePlatformArgs([
        'install',
        '--name',
        'company',
        '--application-domain',
        'apps.example.com',
        '--zone',
        'example.com',
        '--account',
        'abc',
        '--plan',
      ]),
    ).toMatchObject({ subcommand: 'install', name: 'company', plan: true });
  });
});
