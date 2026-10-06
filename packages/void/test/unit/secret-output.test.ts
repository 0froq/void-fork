import { stripVTControlCharacters } from 'node:util';
import { expect, it, vi } from 'vite-plus/test';
import { runSecretCommand } from '../../src/cli/secret.ts';

vi.mock('../../src/cli/auth.ts', () => ({ getToken: () => 'fixture' }));
vi.mock('../../src/cli/client.ts', () => ({
  PlatformClient: class {
    async listSecrets() {
      return [{ name: 'API_KEY' }];
    }
  },
}));
vi.mock('../../src/cli/project.ts', () => ({
  readDeploymentPlatform: () => 'void',
  readProjectConfig: () => ({ projectId: 'project' }),
}));

it.each([0, 2])('lists secrets when the terminal reports %i columns', async (columns) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns });
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    await runSecretCommand('/fixture', { action: 'list' });
    const text = stripVTControlCharacters(output);
    const contents = text
      .split('\n')
      .filter((line) => line.startsWith('│'))
      .map((line) => line.slice(1, -1).trim())
      .join('');
    expect(contents).toContain('API_KEY');
    expect(text).toContain('1 secret');
  } finally {
    write.mockRestore();
    if (descriptor) {
      Object.defineProperty(process.stdout, 'columns', descriptor);
    } else {
      Reflect.deleteProperty(process.stdout, 'columns');
    }
  }
});
