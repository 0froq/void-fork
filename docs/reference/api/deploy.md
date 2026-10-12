# Deployment artifacts

Use `void/deploy` from Node.js to prepare a built Void app for a managed platform deployment without platform credentials.

```ts
import { prepareDeployArtifact } from 'void/deploy';

const { artifact, assets } = await prepareDeployArtifact('/path/to/app');
```

Build the app first for its connected Void platform. `artifact` contains the deployment manifest, content-addressed asset metadata, and base64 Worker modules. `assets` maps asset URL paths to base64 bytes. Keep this result immutable while requesting [publish approval](/guide/platform/administration/connected-apps).

Preparation packages existing build output; it does not build, contact a platform, provision resources, or deploy. It supports Void Cloudflare Worker builds. Node targets, static output, remote data, deploy-time prerendering, Sandbox, and Live resources require the normal `void deploy` workflow instead.

Run preparation inside the same isolated environment as the app build. App configuration and build plugins execute project code; keep platform credentials on the publishing server.
