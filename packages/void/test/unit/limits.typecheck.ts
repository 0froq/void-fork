import { expectTypeOf } from 'vite-plus/test';
import type { SandboxClient, SandboxProcess } from '../../src/runtime/sandbox.ts';

declare const sandboxClient: SandboxClient;
declare const process: SandboxProcess;
expectTypeOf(sandboxClient.exec(['work'])).toEqualTypeOf<Promise<SandboxProcess>>();
expectTypeOf(sandboxClient.run(['work'])).toEqualTypeOf<Promise<ExecOutput>>();
expectTypeOf(sandboxClient.files.readFile('/data')).toEqualTypeOf<Promise<Response>>();
expectTypeOf(process.exitCode).toEqualTypeOf<Promise<number>>();
expectTypeOf(process.output()).toEqualTypeOf<Promise<ExecOutput>>();
// @ts-expect-error Files must be awaited before reading their Response.
sandboxClient.files.readFile('/data').text();
// @ts-expect-error Operations use the standard Promise API.
sandboxClient.run(['work']).match({ ok: (value: unknown) => value, limited: () => null });
