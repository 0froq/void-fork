import { expectTypeOf, it } from 'vite-plus/test';
import type { ai } from '../../src/runtime/ai.ts';

it('types provider fetch calls', () => {
  type ProviderMethod = typeof ai.provider;
  const provider = undefined as unknown as ProviderMethod;

  const assertTypes = () => {
    provider('openai').fetch('/chat/completions', {
      body: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
    provider('custom', { apiKeyEnv: 'CUSTOM_AI_KEY' }).fetch('/v1/respond', {
      method: 'POST',
      headers: { 'x-test': '1' },
      body: new Uint8Array([1, 2]),
    });
  };

  expectTypeOf(assertTypes).toBeFunction();
  expectTypeOf(provider).toBeFunction();
});
