import { describe, expect, it } from 'vite-plus/test';
import { parseCreateArgs } from '../../src/args.ts';

describe('parseCreateArgs', () => {
  it('forwards options after the project name to void init', () => {
    expect(parseCreateArgs(['my-app', '--framework', 'react', '--deploy=none'])).toEqual({
      appName: 'my-app',
      initArgs: ['--framework', 'react', '--deploy=none'],
    });
  });

  it('forwards every argument when no project name is given', () => {
    expect(parseCreateArgs(['--framework', 'vue'])).toEqual({
      appName: undefined,
      initArgs: ['--framework', 'vue'],
    });
    expect(parseCreateArgs([])).toEqual({ appName: undefined, initArgs: [] });
  });

  it('rejects arguments that are not plain flags or values', () => {
    expect(() => parseCreateArgs(['my-app', '--framework', 'react&calc'])).toThrow(
      "create-void: Unsupported argument 'react&calc'.",
    );
  });
});
