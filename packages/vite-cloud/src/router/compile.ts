import type { ScanResult } from "./scan";

export type AuthProvider = "github" | "google" | "email";

export interface AuthCompileOptions {
  providers: AuthProvider[];
  sessionPath: string;
  passwordPath: string | null;
  schemaPath: string;
  githubProviderPath: string | null;
  googleProviderPath: string | null;
}

export interface CompileOptions {
  /** Absolute path to the hono module entry */
  honoPath: string;
  /** Absolute path to the vite-cloud/response module */
  responsePath: string;
  /** Whether to inject React Fast Refresh preamble in dev SSR HTML. */
  reactRefresh: boolean;
  /** Auth configuration (null = disabled) */
  auth: AuthCompileOptions | null;
}

export interface SsrCompileOptions {
  /** Absolute path to src/main.ssr.ts(x) */
  serverEntryPath: string;
  /** Relative project path for src/main.client.ts(x), e.g. src/main.client.tsx */
  clientEntryRelativePath: string;
}

/**
 * Generate the code for the virtual route table module (virtual:vite-cloud-routes).
 * This module creates a Hono app with:
 * - Middleware registered via app.use()
 * - Routes registered with lazy-loaded handlers and auto-conversion
 */
export function compileRouteTable(
  scan: ScanResult,
  routesDir: string,
  middlewareDir: string,
  jobsDir: string,
  queuesDir: string,
  ssr: SsrCompileOptions | null,
  options: CompileOptions,
): string {
  const lines: string[] = [];
  const auth = options.auth;

  lines.push(`import { AsyncLocalStorage } from "node:async_hooks";`);
  lines.push(`import { Hono } from ${JSON.stringify(options.honoPath)};`);
  lines.push(`import { convertReturnValue } from ${JSON.stringify(options.responsePath)};`);

  // Auth imports
  if (auth) {
    lines.push(
      `import { parseSessionCookie, buildSetCookieHeader, buildClearCookieHeader, generateSessionId, SESSION_TTL_SECONDS } from ${JSON.stringify(auth.sessionPath)};`,
    );
    lines.push(
      `import { CREATE_AUTH_TABLES_SQL, generateUserId } from ${JSON.stringify(auth.schemaPath)};`,
    );
    if (auth.passwordPath) {
      lines.push(
        `import { hashPassword, verifyPassword } from ${JSON.stringify(auth.passwordPath)};`,
      );
    }
    if (auth.githubProviderPath) {
      lines.push(`import { githubAuth } from ${JSON.stringify(auth.githubProviderPath)};`);
    }
    if (auth.googleProviderPath) {
      lines.push(`import { googleAuth } from ${JSON.stringify(auth.googleProviderPath)};`);
    }
  }
  lines.push("");

  // Generate eager imports for middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    const mw = scan.middleware[i];
    lines.push(`import middleware${i} from ${JSON.stringify(`${middlewareDir}/${mw.filePath}`)};`);
  }
  lines.push("");

  lines.push(`const app = new Hono();`);
  lines.push(`export const requestContext = new AsyncLocalStorage();`);
  lines.push("");

  // Request context middleware — threads outer request into ALS for isomorphic fetch
  lines.push("app.use(async (c, next) => {");
  lines.push(
    "  await requestContext.run({ request: c.req.raw, executionCtx: c.executionCtx }, next);",
  );
  lines.push("});");
  lines.push("");

  // Auth: ensure tables exist + session middleware
  if (auth) {
    lines.push("let authReady = false;");
    lines.push("app.use(async (c, next) => {");
    lines.push("  if (!authReady) {");
    lines.push("    await c.env.DB.prepare(CREATE_AUTH_TABLES_SQL).run();");
    lines.push("    authReady = true;");
    lines.push("  }");
    lines.push("  await next();");
    lines.push("});");
    lines.push("");
    lines.push("app.use(async (c, next) => {");
    lines.push('  const sid = parseSessionCookie(c.req.header("cookie"));');
    lines.push("  if (sid) {");
    lines.push('    const session = await c.env.AUTH_KV.get("session:" + sid, "json");');
    lines.push("    if (session && session.expiresAt > Date.now()) {");
    lines.push('      c.set("user", {');
    lines.push("        id: session.userId,");
    lines.push("        provider: session.provider,");
    lines.push("        email: session.email,");
    lines.push("        name: session.name,");
    lines.push("        avatar_url: session.avatar_url,");
    lines.push("      });");
    lines.push("    }");
    lines.push("  }");
    lines.push("  await next();");
    lines.push("});");
    lines.push("");
  }

  // Register user middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    lines.push(`app.use(middleware${i});`);
  }
  if (scan.middleware.length > 0) {
    lines.push("");
  }

  // Auth routes
  if (auth) {
    compileAuthRoutes(lines, auth);
  }

  // Register routes with lazy-loaded handlers (shared loader per file)
  const seenFiles = new Set<string>();
  for (const route of scan.routes) {
    const filePath = `${routesDir}/${route.filePath}`;
    const varName = `_mod_${route.filePath.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const loaderName = `_load_${route.filePath.replace(/[^a-zA-Z0-9]/g, "_")}`;

    if (!seenFiles.has(route.filePath)) {
      seenFiles.add(route.filePath);
      lines.push(`let ${varName};`);
      lines.push(`async function ${loaderName}() {`);
      lines.push(`  if (!${varName}) ${varName} = await import(${JSON.stringify(filePath)});`);
      lines.push(`  return ${varName};`);
      lines.push(`}`);
    }

    if (route.methods.length === 0) {
      // No recognized HTTP exports — register as all()
      lines.push(`app.all(${JSON.stringify(route.pattern)}, async (c) => {`);
      lines.push(`  const mod = await ${loaderName}();`);
      lines.push(`  return convertReturnValue(await mod.default(c));`);
      lines.push(`});`);
    } else {
      for (const method of route.methods) {
        const honoMethod = method.toLowerCase();
        lines.push(`app.${honoMethod}(${JSON.stringify(route.pattern)}, async (c) => {`);
        lines.push(`  const mod = await ${loaderName}();`);
        lines.push(`  return convertReturnValue(await mod.${method}(c));`);
        lines.push(`});`);
      }
    }
  }
  lines.push("");

  if (ssr) {
    const clientEntryUrl = `/${ssr.clientEntryRelativePath}`;
    lines.push(`const SSR_CLIENT_ENTRY_ID = ${JSON.stringify(ssr.clientEntryRelativePath)};`);
    lines.push(`const SSR_CLIENT_ENTRY_URL = ${JSON.stringify(clientEntryUrl)};`);
    lines.push(`let cachedSsrManifest = null;`);
    lines.push("");
    lines.push(`function escapeHtml(value) {`);
    lines.push(`  return String(value).replace(/"/g, "&quot;");`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function getDevClientTags() {`);
    lines.push(`  const headTags = [\`<script type="module" src="/@vite/client"></script>\`];`);
    if (options.reactRefresh) {
      lines.push(`  headTags.push(\`<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>\`);`);
    }
    lines.push(
      `  const bodyTag = \`<script type="module" src="\${escapeHtml(SSR_CLIENT_ENTRY_URL)}"></script>\`;`,
    );
    lines.push(`  return { head: headTags.join("\\n"), body: bodyTag };`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function collectManifestFiles(manifest, entryId) {`);
    lines.push(`  const seen = new Set();`);
    lines.push(`  const toVisit = [entryId];`);
    lines.push(`  while (toVisit.length > 0) {`);
    lines.push(`    const currentId = toVisit.pop();`);
    lines.push(`    if (seen.has(currentId)) continue;`);
    lines.push(`    seen.add(currentId);`);
    lines.push(`    const chunk = manifest[currentId];`);
    lines.push(`    if (!chunk || !Array.isArray(chunk.imports)) continue;`);
    lines.push(`    for (const importedId of chunk.imports) toVisit.push(importedId);`);
    lines.push(`  }`);
    lines.push(`  return Array.from(seen);`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function loadSsrManifest(request, env) {`);
    lines.push(`  if (cachedSsrManifest) return cachedSsrManifest;`);
    lines.push(`  const assets = env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") return null;`);
    lines.push(`  const manifestUrl = new URL("/.vite/manifest.json", request.url);`);
    lines.push(`  const response = await assets.fetch(new Request(manifestUrl.toString()));`);
    lines.push(`  if (!response.ok) return null;`);
    lines.push(`  cachedSsrManifest = await response.json();`);
    lines.push(`  return cachedSsrManifest;`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function getClientAssetTags(request, env) {`);
    lines.push(`  const manifest = await loadSsrManifest(request, env);`);
    lines.push(`  if (!manifest || typeof manifest !== "object") {`);
    lines.push(`    return getDevClientTags();`);
    lines.push(`  }`);
    lines.push(`  const entry = manifest[SSR_CLIENT_ENTRY_ID];`);
    lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
    lines.push(`    return { head: "", body: "" };`);
    lines.push(`  }`);
    lines.push(`  const ids = collectManifestFiles(manifest, SSR_CLIENT_ENTRY_ID);`);
    lines.push(`  const cssFiles = new Set();`);
    lines.push(`  const preloadFiles = new Set();`);
    lines.push(`  for (const id of ids) {`);
    lines.push(`    const chunk = manifest[id];`);
    lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
    lines.push(`    if (Array.isArray(chunk.css)) {`);
    lines.push(`      for (const cssFile of chunk.css) cssFiles.add(cssFile);`);
    lines.push(`    }`);
    lines.push(`    if (id !== SSR_CLIENT_ENTRY_ID && typeof chunk.file === "string") {`);
    lines.push(`      preloadFiles.add(chunk.file);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  const headTags = [];`);
    lines.push(`  for (const cssFile of cssFiles) {`);
    lines.push(`    headTags.push(\`<link rel="stylesheet" href="/\${escapeHtml(cssFile)}">\`);`);
    lines.push(`  }`);
    lines.push(`  for (const preloadFile of preloadFiles) {`);
    lines.push(
      `    headTags.push(\`<link rel="modulepreload" href="/\${escapeHtml(preloadFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(
      `  const bodyTag = \`<script type="module" src="/\${escapeHtml(entry.file)}"></script>\`;`,
    );
    lines.push(`  return { head: headTags.join("\\n"), body: bodyTag };`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function shouldHandleSsrRequest(c) {`);
    lines.push(`  const path = c.req.path;`);
    lines.push(`  if (path === "/api" || path.startsWith("/api/")) return false;`);
    lines.push(`  if (/\\/[^/]+\\.[^/]+$/.test(path)) return false;`);
    lines.push(`  const destination = c.req.header("sec-fetch-dest");`);
    lines.push(
      `  if (destination && destination !== "document" && destination !== "empty") return false;`,
    );
    lines.push(`  return true;`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function fetchFromAssets(c) {`);
    lines.push(`  const assets = c.env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") {`);
    lines.push(`    return new Response("Not Found", { status: 404 });`);
    lines.push(`  }`);
    lines.push(`  const response = await assets.fetch(c.req.raw);`);
    lines.push(
      `  return response.status === 404 ? new Response("Not Found", { status: 404 }) : response;`,
    );
    lines.push(`}`);
    lines.push("");
    lines.push(`async function renderSsrResponse(c, mod) {`);
    lines.push(`  const render = typeof mod.render === "function" ? mod.render : mod.default;`);
    lines.push(`  if (typeof render !== "function") {`);
    lines.push(
      `    throw new Error("Invalid SSR entry: expected exported render(c, assetTags) function.");`,
    );
    lines.push(`  }`);
    lines.push(`  const assetTags = await getClientAssetTags(c.req.raw, c.env);`);
    lines.push(`  return render(c, assetTags);`);
    lines.push(`}`);
    lines.push("");
    lines.push(`app.notFound(async (c) => {`);
    lines.push(`  if (!shouldHandleSsrRequest(c)) {`);
    lines.push(`    return fetchFromAssets(c);`);
    lines.push(`  }`);
    lines.push(`  const mod = await import(${JSON.stringify(ssr.serverEntryPath)});`);
    lines.push(`  return renderSsrResponse(c, mod);`);
    lines.push(`});`);
    lines.push("");
  }

  if (scan.jobs.length > 0) {
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      lines.push(`const job${i}Cron = ${JSON.stringify(job.cron)};`);
    }
    lines.push("");
    lines.push("export async function scheduled(controller, env, ctx) {");
    lines.push("  switch (controller.cron) {");
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      const filePath = JSON.stringify(`${jobsDir}/${job.filePath}`);
      lines.push(`    case job${i}Cron: {`);
      lines.push(`      const mod = await import(${filePath});`);
      lines.push("      if (typeof mod.default === 'function') {");
      lines.push("        await mod.default(controller, env, ctx);");
      lines.push("      }");
      lines.push("      return;");
      lines.push("    }");
    }
    lines.push("    default:");
    lines.push("      return;");
    lines.push("  }");
    lines.push("}");
    lines.push("");
  } else {
    lines.push("export async function scheduled() {}");
    lines.push("");
  }

  if (scan.queues.length > 0) {
    for (let i = 0; i < scan.queues.length; i++) {
      lines.push(`const queue${i}Name = ${JSON.stringify(scan.queues[i].name)};`);
    }
    lines.push("");
    lines.push('app.post("/__queue", async (c) => {');
    lines.push("  const payload = await c.req.json();");
    lines.push("  const queueSuffix = payload.queue;");
    for (let i = 0; i < scan.queues.length; i++) {
      const q = scan.queues[i];
      const cond = i === 0 ? "if" : "} else if";
      lines.push(
        `  ${cond} (queueSuffix === queue${i}Name || queueSuffix.endsWith("-" + queue${i}Name)) {`,
      );
      lines.push(`    const mod = await import(${JSON.stringify(`${queuesDir}/${q.filePath}`)});`);
      lines.push("    if (typeof mod.default === 'function') await mod.default(payload, c.env);");
    }
    lines.push("  }");
    lines.push("  return c.json({ ok: true });");
    lines.push("});");
    lines.push("");
  }

  lines.push(`export default app;`);

  return lines.join("\n");
}

function compileAuthRoutes(lines: string[], auth: AuthCompileOptions): void {
  const hasEmail = auth.providers.includes("email");
  const hasGitHub = auth.providers.includes("github");
  const hasGoogle = auth.providers.includes("google");

  if (hasEmail) {
    // POST /auth/register
    lines.push('app.post("/auth/register", async (c) => {');
    lines.push("  const { email, password, name } = await c.req.json();");
    lines.push(
      '  if (!email || !password) return c.json({ error: "email and password required" }, 400);',
    );
    lines.push("  const existing = await c.env.DB.prepare(");
    lines.push("    \"SELECT id FROM auth_users WHERE provider = 'email' AND provider_id = ?\"");
    lines.push("  ).bind(email).first();");
    lines.push('  if (existing) return c.json({ error: "email already registered" }, 409);');
    lines.push("  const userId = generateUserId();");
    lines.push("  const hash = await hashPassword(password);");
    lines.push("  await c.env.DB.prepare(");
    lines.push(
      "    \"INSERT INTO auth_users (id, provider, provider_id, email, name, password_hash) VALUES (?, 'email', ?, ?, ?, ?)\"",
    );
    lines.push("  ).bind(userId, email, email, name ?? null, hash).run();");
    lines.push("  const sessionId = generateSessionId();");
    lines.push('  await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push('    userId, provider: "email", email, name: name ?? null, avatar_url: null,');
    lines.push("    createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("  }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('  const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("  const headers = new Headers();");
    lines.push('  headers.set("Set-Cookie", buildSetCookieHeader(sessionId, secure));');
    lines.push(
      "  return c.json({ id: userId, email, name: name ?? null }, { status: 201, headers });",
    );
    lines.push("});");
    lines.push("");

    // POST /auth/login
    lines.push('app.post("/auth/login", async (c) => {');
    lines.push("  const { email, password } = await c.req.json();");
    lines.push(
      '  if (!email || !password) return c.json({ error: "email and password required" }, 400);',
    );
    lines.push("  const user = await c.env.DB.prepare(");
    lines.push(
      "    \"SELECT id, email, name, avatar_url, password_hash FROM auth_users WHERE provider = 'email' AND provider_id = ?\"",
    );
    lines.push("  ).bind(email).first();");
    lines.push(
      '  if (!user || !user.password_hash) return c.json({ error: "invalid credentials" }, 401);',
    );
    lines.push("  const valid = await verifyPassword(password, user.password_hash);");
    lines.push('  if (!valid) return c.json({ error: "invalid credentials" }, 401);');
    lines.push("  const sessionId = generateSessionId();");
    lines.push('  await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push(
      '    userId: user.id, provider: "email", email: user.email, name: user.name, avatar_url: user.avatar_url,',
    );
    lines.push("    createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("  }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('  const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("  const headers = new Headers();");
    lines.push('  headers.set("Set-Cookie", buildSetCookieHeader(sessionId, secure));');
    lines.push(
      "  return c.json({ id: user.id, email: user.email, name: user.name }, { headers });",
    );
    lines.push("});");
    lines.push("");
  }

  if (hasGitHub) {
    lines.push('app.get("/auth/login/github",');
    lines.push("  (c, next) => githubAuth({");
    lines.push("    client_id: c.env.GITHUB_OAUTH_ID,");
    lines.push("    client_secret: c.env.GITHUB_OAUTH_SECRET,");
    lines.push('    scope: ["read:user", "user:email"],');
    lines.push("    oauthApp: true,");
    lines.push("  })(c, next),");
    lines.push("  async (c) => {");
    lines.push('    const ghUser = c.get("user-github");');
    lines.push("    const providerId = String(ghUser.id);");
    lines.push("    let user = await c.env.DB.prepare(");
    lines.push(
      "      \"SELECT id, email, name, avatar_url FROM auth_users WHERE provider = 'github' AND provider_id = ?\"",
    );
    lines.push("    ).bind(providerId).first();");
    lines.push("    if (!user) {");
    lines.push("      const userId = generateUserId();");
    lines.push("      await c.env.DB.prepare(");
    lines.push(
      "        \"INSERT INTO auth_users (id, provider, provider_id, email, name, avatar_url) VALUES (?, 'github', ?, ?, ?, ?)\"",
    );
    lines.push(
      "      ).bind(userId, providerId, ghUser.email ?? null, ghUser.name ?? ghUser.login ?? null, ghUser.avatar_url ?? null).run();",
    );
    lines.push(
      "      user = { id: userId, email: ghUser.email, name: ghUser.name ?? ghUser.login, avatar_url: ghUser.avatar_url };",
    );
    lines.push("    }");
    lines.push("    const sessionId = generateSessionId();");
    lines.push('    await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push(
      '      userId: user.id, provider: "github", email: user.email, name: user.name, avatar_url: user.avatar_url,',
    );
    lines.push("      createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("    }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('    const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("    return new Response(null, { status: 302, headers: {");
    lines.push('      Location: "/", "Set-Cookie": buildSetCookieHeader(sessionId, secure)');
    lines.push("    }});");
    lines.push("  }");
    lines.push(");");
    lines.push("");
  }

  if (hasGoogle) {
    lines.push('app.get("/auth/login/google",');
    lines.push("  (c, next) => googleAuth({");
    lines.push("    client_id: c.env.GOOGLE_OAUTH_ID,");
    lines.push("    client_secret: c.env.GOOGLE_OAUTH_SECRET,");
    lines.push('    scope: ["openid", "email", "profile"],');
    lines.push("  })(c, next),");
    lines.push("  async (c) => {");
    lines.push('    const googleUser = c.get("user-google");');
    lines.push("    const providerId = String(googleUser.id);");
    lines.push("    let user = await c.env.DB.prepare(");
    lines.push(
      "      \"SELECT id, email, name, avatar_url FROM auth_users WHERE provider = 'google' AND provider_id = ?\"",
    );
    lines.push("    ).bind(providerId).first();");
    lines.push("    if (!user) {");
    lines.push("      const userId = generateUserId();");
    lines.push("      await c.env.DB.prepare(");
    lines.push(
      "        \"INSERT INTO auth_users (id, provider, provider_id, email, name, avatar_url) VALUES (?, 'google', ?, ?, ?, ?)\"",
    );
    lines.push(
      "      ).bind(userId, providerId, googleUser.email ?? null, googleUser.name ?? null, googleUser.picture ?? null).run();",
    );
    lines.push(
      "      user = { id: userId, email: googleUser.email, name: googleUser.name, avatar_url: googleUser.picture };",
    );
    lines.push("    }");
    lines.push("    const sessionId = generateSessionId();");
    lines.push('    await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push(
      '      userId: user.id, provider: "google", email: user.email, name: user.name, avatar_url: user.avatar_url,',
    );
    lines.push("      createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("    }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('    const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("    return new Response(null, { status: 302, headers: {");
    lines.push('      Location: "/", "Set-Cookie": buildSetCookieHeader(sessionId, secure)');
    lines.push("    }});");
    lines.push("  }");
    lines.push(");");
    lines.push("");
  }

  // GET /auth/me — always present when auth enabled
  lines.push('app.get("/auth/me", (c) => {');
  lines.push('  const user = c.get("user");');
  lines.push('  if (!user) return c.json({ error: "unauthorized" }, 401);');
  lines.push("  return c.json(user);");
  lines.push("});");
  lines.push("");

  // POST /auth/logout — always present when auth enabled
  lines.push('app.post("/auth/logout", async (c) => {');
  lines.push('  const sid = parseSessionCookie(c.req.header("cookie"));');
  lines.push('  if (sid) await c.env.AUTH_KV.delete("session:" + sid);');
  lines.push("  return new Response(null, { status: 302, headers: {");
  lines.push('    Location: "/", "Set-Cookie": buildClearCookieHeader()');
  lines.push("  }});");
  lines.push("});");
  lines.push("");
}

/**
 * Generate the Worker entry module code.
 * Simply re-exports the Hono app from the virtual module.
 *
 * When `hasQueues` is true, also exports a `queue()` handler that
 * serializes the native MessageBatch and dispatches it to the
 * `/__queue` Hono route. In local dev Miniflare delivers batches
 * natively to this export; in production the relay worker does it.
 */
export function compileWorkerEntry(hasQueues = false): string {
  if (hasQueues) {
    return `import app, { scheduled } from 'virtual:vite-cloud-routes';

async function queue(batch, env, ctx) {
  const messages = [...batch.messages].map(m => ({
    id: m.id, timestamp: m.timestamp.toISOString(),
    body: m.body, attempts: m.attempts,
  }));
  const req = new Request("https://localhost/__queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queue: batch.queue, messages }),
  });
  await app.fetch(req, env, ctx);
}

export default { fetch: app.fetch, scheduled, queue };`;
  }
  return `import app, { scheduled } from 'virtual:vite-cloud-routes';

export default { fetch: app.fetch, scheduled };`;
}

/**
 * Generate the worker-side fetch client module (virtual:vite-cloud-client-worker).
 *
 * In the worker environment, `vite-cloud/client` is redirected here instead of
 * the ofetch-based client. This calls `app.fetch()` directly (no HTTP round-trip),
 * enabling isomorphic fetch during SSR and in route handlers.
 *
 * Cookie and authorization headers from the outer request are auto-forwarded
 * via AsyncLocalStorage context. User-specified headers take precedence.
 */
export function compileWorkerClient(authClientPath: string): string {
  return `import app, { requestContext } from "virtual:vite-cloud-routes";
import { env } from "cloudflare:workers";
export { auth, AuthError } from ${JSON.stringify(authClientPath)};

export class FetchError extends Error {
  constructor(status, statusText, data) {
    super(\`Request failed with status \${status}\`);
    this.name = "FetchError";
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

export async function fetch(path, options) {
  let url = path;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url = url.replace(":" + key, encodeURIComponent(value));
    }
  }

  if (options?.query) {
    const qs = new URLSearchParams(options.query).toString();
    if (qs) url += "?" + qs;
  }

  const method = options?.method ?? "GET";
  const headers = new Headers(options?.headers);

  // Auto-forward cookie and authorization from the outer request via ALS
  const store = requestContext.getStore();
  if (store?.request) {
    const outerReq = store.request;
    if (!headers.has("cookie")) {
      const cookie = outerReq.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
    }
    if (!headers.has("authorization")) {
      const auth = outerReq.headers.get("authorization");
      if (auth) headers.set("authorization", auth);
    }
  }

  if (options?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request("http://worker.local" + url, {
    method,
    headers,
    body: options?.body != null ? JSON.stringify(options.body) : undefined,
  });

  // Use real executionCtx from ALS if available, otherwise provide a no-op fallback
  const executionCtx = store?.executionCtx ?? { waitUntil() {}, passThroughOnException() {} };
  const response = await app.fetch(request, env, executionCtx);

  if (response.status === 204) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new FetchError(response.status, response.statusText, data);
  }

  return data;
}
`;
}
