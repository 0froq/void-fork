import { describe, expect, it } from 'vite-plus/test';
import { parseCreateArgs, validateProjectName } from '../../src/args.ts';

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

  it.each(['MyApp', 'my-App', 'MY-APP'])('rejects an uppercase project name: %s', (name) => {
    expect(() => parseCreateArgs([name])).toThrow('create-void: Project name must be lowercase');
  });

  it('rejects arguments that are not plain flags or values', () => {
    expect(() => parseCreateArgs(['my-app', '--framework', 'react&calc'])).toThrow(
      "create-void: Unsupported argument 'react&calc'.",
    );
  });
});

describe('validateProjectName', () => {
  it.each(['MyApp', 'my-App', 'MY-APP'])('rejects uppercase names: %s', (name) => {
    expect(validateProjectName(name)).toBe('Project name must be lowercase');
  });

  it.each(['my-app', 'app123', 'nested/my-app', '.'])('accepts lowercase names: %s', (name) => {
    expect(validateProjectName(name)).toBeUndefined();
  });

  it('allows the prompt default and rejects whitespace-only names', () => {
    expect(validateProjectName(undefined)).toBeUndefined();
    expect(validateProjectName('')).toBeUndefined();
    expect(validateProjectName('   ')).toBe('Project name cannot be blank');
  });
});
