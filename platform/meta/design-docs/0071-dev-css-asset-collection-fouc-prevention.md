---
title: Development CSS Asset Collection
status: implemented
---

# Development CSS asset collection

Pages and island server renders need styles before the browser paints their initial HTML. In development, Void collects CSS associated with the active render from Vite's module graph and inlines it in the response. Production continues to use built assets and manifest-derived stylesheets.

The collector is a Vite plugin shared by Pages and island rendering. It tracks module relationships and requests transformed CSS through Vite rather than parsing application source for imports. See [the collector](../../../packages/void/src/pages/dev-css-assets.ts), [plugin registration](../../../packages/void/src/index.ts), and [Pages rendering](../../../packages/void/src/pages/protocol.ts).
