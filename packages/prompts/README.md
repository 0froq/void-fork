# Temporary shared terminal renderer

This private workspace contains the unmodified build of `@voidzero-dev/vite-plus-prompts` from [Vite+ PR #2870](https://github.com/voidzero-dev/vite-plus/pull/2870). `upstream.json` records the source commit, build command and artifact hashes. Both `void` and `create-void` bundle this package and its runtime dependencies into their published CLI files; consumers never install this private package.

Build the upstream `packages/prompts` package with tsdown, then copy `dist/index.mjs`, `dist/index.d.mts` and the upstream license here. Update the provenance and hashes together. Keep generated files byte-for-byte intact; make renderer changes in Vite+ so both projects retain the same visual identity.

Once that PR is published, remove this workspace and change the consumer `workspace:*` dev dependencies to the published version. Imports and `onlyBundle` entries already use the official name. Run `vp install`, CLI tests, package builds and the full packed-consumer matrix.
