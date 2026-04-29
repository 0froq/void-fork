/**
 * Compile-time contract test pinning the framework's manifest wire shape for
 * routing rules. The platform receives `redirectRules` and `fallbackRules`
 * via the deploy manifest uploaded by the framework CLI; if the framework
 * renames or restructures those fields, this file must fail to typecheck.
 *
 * Imports `RedirectRule` directly from the framework submodule source so
 * framework-side drift (a new optional field, a type change, a rename) is
 * caught by `pnpm check` on the platform side. The relative path is the
 * honest representation of the cross-repo contract — CI already runs
 * `git submodule update --init` before typecheck, so resolution works.
 *
 * `types.ts` in the framework is pure TypeScript types with no runtime
 * imports, and `skipLibCheck: true` in the dispatch tsconfig keeps the
 * transitive graph cheap.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line import/no-relative-packages -- intentional cross-submodule contract reference
import type { RedirectRule as FrameworkRule } from '../../../../framework/packages/void/src/cli/types';
import type { RedirectRule as ApiRule } from '../../../api/src/types';
import type { RedirectRule as DispatchRule } from '../../src/routing-rules';

// --- Compile-time assertions (evaluated by tsc; any mismatch breaks typecheck) ---

// Structural equivalence across all three shapes. If any side adds a required
// field (or removes/renames one) that the others don't mirror, one of these
// assignments fails.
const _wire: Array<FrameworkRule> = [
  { source: '/old', destination: '/new', status: 301 },
  { source: '/docs/*', destination: '/en/docs/:splat', status: 200 },
];
const _asDispatch: Array<DispatchRule> = _wire;
const _asApi: Array<ApiRule> = _wire;
const _dispatchAsApi: Array<ApiRule> = _asDispatch;
const _apiAsFramework: Array<FrameworkRule> = _asApi;
void _asDispatch;
void _asApi;
void _dispatchAsApi;
void _apiAsFramework;

// Pin the routing-entry container shape (module-private in dispatch/index.ts).
const _entry: {
  redirectRules?: Array<DispatchRule>;
  fallbackRules?: Array<DispatchRule>;
} = { redirectRules: _wire, fallbackRules: _wire };
void _entry;

// Pin the key set on every side. If `force` (or any other dev-only field)
// leaks back onto a public `RedirectRule`, `Exclude<...>` resolves to a
// non-`never` type and the `never` assignment below fails.
type _FrameworkExtras = Exclude<keyof FrameworkRule, 'source' | 'destination' | 'status'>;
const _noFrameworkExtras: _FrameworkExtras extends never ? true : false = true;
void _noFrameworkExtras;

type _DispatchExtras = Exclude<keyof DispatchRule, 'source' | 'destination' | 'status'>;
const _noDispatchExtras: _DispatchExtras extends never ? true : false = true;
void _noDispatchExtras;

type _ApiExtras = Exclude<keyof ApiRule, 'source' | 'destination' | 'status'>;
const _noApiExtras: _ApiExtras extends never ? true : false = true;
void _noApiExtras;

describe('framework wire-shape contract', () => {
  it('framework, dispatch, and api RedirectRule share the pinned key set', () => {
    // Real enforcement is at compile time (see top-of-file assertions). This
    // runtime assertion documents the pinned key set and keeps vitest from
    // reporting the file as empty.
    const sample: FrameworkRule = { source: '/a', destination: '/b', status: 301 };
    expect(Object.keys(sample).sort()).toEqual(['destination', 'source', 'status']);
  });
});
