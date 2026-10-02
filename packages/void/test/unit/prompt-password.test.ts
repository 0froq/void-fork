import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { isCancel } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { passwordWithPlaceholder } from '../../src/cli/prompt-password.ts';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllEnvs();
});

function openPrompt(validate?: (value: string | undefined) => string | undefined) {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
  const writes: Array<string> = [];
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      },
    }),
    { columns: 80, rows: 24 },
  );
  const controller = new AbortController();
  const result = passwordWithPlaceholder({
    message: 'PostgreSQL DATABASE_URL:',
    placeholder: 'postgresql://user:pw@…/database',
    input,
    output,
    signal: controller.signal,
    validate: validate ?? ((value) => (value ? undefined : 'A value is required.')),
  });
  cleanup = async () => {
    controller.abort();
    await result;
    input.destroy();
    output.destroy();
  };
  return {
    result,
    writes,
    key: (key: string) => input.emit('data', Buffer.from(key)),
    rendered: () => stripVTControlCharacters(writes.join('')),
  };
}

it('shows a placeholder without accepting it as a default', async () => {
  const prompt = openPrompt();
  expect(prompt.rendered()).toContain('postgresql://user:pw@…/database');
  prompt.key('\r');
  await vi.waitFor(() => expect(prompt.rendered()).toContain('A value is required.'));
  prompt.key('real-secret');
  prompt.key('\r');
  expect(await prompt.result).toBe('real-secret');
  expect(prompt.rendered()).not.toContain('real-secret');
});

it.each(['', '1'])(
  'never echoes the database URL on submission (ACCESSIBLE=%s)',
  async (accessible) => {
    vi.stubEnv('ACCESSIBLE', accessible);
    const prompt = openPrompt();
    const secret = 'postgresql://owner:secret@database.example/db';
    prompt.writes.length = 0;
    prompt.key(secret);
    expect(prompt.rendered()).not.toContain('postgresql://');
    prompt.key('\r');
    expect(await prompt.result).toBe(secret);
    expect(prompt.rendered()).not.toContain(secret);
    expect(prompt.rendered()).not.toContain('owner:secret');
  },
);

it('keeps rejected and cancelled values masked', async () => {
  const prompt = openPrompt(() => 'Invalid URL.');
  prompt.key('invalid-secret');
  prompt.key('\r');
  await vi.waitFor(() => expect(prompt.rendered()).toContain('Invalid URL.'));
  prompt.key('\x03');
  expect(isCancel(await prompt.result)).toBe(true);
  expect(prompt.rendered()).not.toContain('invalid-secret');
});
