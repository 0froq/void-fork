import { expectTypeOf } from 'vite-plus/test';
import type { ai } from '../../src/runtime/ai.ts';
import type { LimitOperation } from '../../src/runtime/limits.ts';
declare const operation: LimitOperation<string>;
// @ts-expect-error A successful branch alone cannot execute the operation.
operation.match({ ok: (value) => value });
// @ts-expect-error A limit branch alone cannot execute the operation.
operation.match({ limited: (limit) => limit.response() });
expectTypeOf(operation.match({ ok: (value) => value.length, limited: () => null })).toEqualTypeOf<
  Promise<number | null>
>();
expectTypeOf<ReturnType<typeof ai.stream>>().toEqualTypeOf<LimitOperation<Response>>();
// @ts-expect-error The old Promise API is no longer available.
operation.then((value) => value);
import type { SandboxClient } from '../../src/runtime/sandbox.ts';
declare const sandboxClient: SandboxClient;
// @ts-expect-error Execution requires a limited branch.
sandboxClient.run(['work']).match({ ok: (result) => result.exitCode });
// @ts-expect-error Files cannot be treated as fulfilled Responses before matching.
sandboxClient.files.readFile('/data').text();
