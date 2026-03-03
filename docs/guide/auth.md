---
outline: deep
---

# Authentication

Void includes built-in authentication with cookie-based sessions, email/password login, and OAuth providers. Auth is auto-detected from your code — when you import `auth` from `void/client` or `requireAuth` from `void/auth`, auth routes and session middleware are generated automatically.

## Auto-Detection

Auth is enabled automatically when Void detects:

1. **Import detection**: Importing `auth` from `void/client` or anything from `void/auth` enables email auth
2. **OAuth from env vars**: Setting `GITHUB_OAUTH_ID` or `GOOGLE_OAUTH_ID` in `.env.local` adds the corresponding OAuth provider

No configuration in `void.json` is needed. Just use the auth APIs and set up your OAuth credentials — everything else is handled for you.

You can also [configure auth explicitly](#explicit-configuration) in `void.json` under `inference.auth` to override auto-detection.

## Auth Routes

The following routes are generated based on your enabled providers:

| Route                | Method | Providers | Description                           |
| -------------------- | ------ | --------- | ------------------------------------- |
| `/auth/register`     | POST   | email     | Create a new account with password    |
| `/auth/login`        | POST   | email     | Sign in with email and password       |
| `/auth/login/github` | GET    | github    | Start GitHub OAuth flow               |
| `/auth/login/google` | GET    | google    | Start Google OAuth flow               |
| `/auth/me`           | GET    | all       | Return the current user (or 401)      |
| `/auth/logout`       | POST   | all       | Clear the session cookie and sign out |

### Email/password

Use the `auth` helpers from `void/client`:

```ts
import { auth } from "void/client";

// Register a new user
const user = await auth.register({
  email: "alice@example.com",
  password: "s3cret",
  name: "Alice", // optional
});

// Sign in
const user = await auth.login({
  email: "alice@example.com",
  password: "s3cret",
});
```

Both methods set a `__void_session` cookie on success and return the `AuthUser` object. They throw an `AuthError` on failure (wrong credentials, duplicate email, etc.).

### OAuth

For GitHub and Google, link directly to the login route:

```html
<a href="/auth/login/github">Login with GitHub</a>
<a href="/auth/login/google">Login with Google</a>
```

The user is redirected to the provider, then back to your app with a session cookie set.

#### OAuth credentials

OAuth providers require client credentials. Add them to [`.env.local`](./env-vars) for local development:

```
GITHUB_OAUTH_ID=your-github-client-id
GITHUB_OAUTH_SECRET=your-github-client-secret
GOOGLE_OAUTH_ID=your-google-client-id
GOOGLE_OAUTH_SECRET=your-google-client-secret
```

For production, set these as secrets via `void secret put` or `void secret sync .env.local`.

#### OAuth callback URLs

The OAuth callback URL is the same as the login URL. Configure these in your OAuth app settings:

| Provider | Dev callback URL                          | Production callback URL                       |
| -------- | ----------------------------------------- | --------------------------------------------- |
| GitHub   | `http://localhost:5173/auth/login/github` | `https://your-app.void.app/auth/login/github` |
| Google   | `http://localhost:5173/auth/login/google` | `https://your-app.void.app/auth/login/google` |

## Getting the Current User

Use `getUser()` to read the authenticated user anywhere in your server code — route handlers, server functions, middleware, or meta-framework loaders:

```ts
import { getUser } from "void/auth";

const user = getUser(); // AuthUser | null
```

This works in both Void apps and [meta-framework apps](../integrations/frameworks/overview.md) (TanStack Start, SvelteKit, Nuxt, etc.). Returns `null` if not authenticated or if called outside a request context.

## Protecting Routes

Use `requireAuth()` to protect a route. It returns the authenticated user or throws a 401:

```ts
// routes/api/profile.ts
import { defineHandler } from "void";
import { requireAuth } from "void/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { user };
});
```

For optional auth (don't throw if not logged in), use `getUser()` or read the user from context directly:

```ts
import { getUser } from "void/auth";

export const GET = defineHandler((c) => {
  const user = getUser(); // AuthUser | null
  return { loggedIn: !!user };
});
```

The session middleware runs on every request and populates the user for both `getUser()` and `c.get("user")`. `requireAuth()` is a convenience that throws if the value is null.

### `getUser()` vs `requireAuth(c)`

|                    | `getUser()`                                 | `requireAuth(c)`                |
| ------------------ | ------------------------------------------- | ------------------------------- |
| **Import**         | `void/auth`                                 | `void/auth`                     |
| **Context needed** | None — reads from AsyncLocalStorage         | Hono `Context` (`c`)            |
| **Returns**        | `AuthUser \| null`                          | `AuthUser` (throws 401 if null) |
| **Works in**       | Void apps, meta-frameworks, any server code | Void app route handlers only    |

Use `getUser()` when you don't have a Hono context or want optional auth. Use `requireAuth(c)` in Void app route handlers where you want a 401 thrown automatically.

### `AuthUser`

```ts
interface AuthUser {
  id: string;
  provider: string; // "email", "github", or "google"
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}
```

## Client Helpers

`void/client` exports an `auth` object with helpers for all auth operations:

```ts
import { auth, AuthError } from "void/client";

const user = await auth.register({ email, password, name }); // AuthUser
const user = await auth.login({ email, password }); // AuthUser
const user = await auth.me(); // AuthUser | null
await auth.logout(); // void
```

`register` and `login` throw `AuthError` on failure. `me` returns `null` when not authenticated instead of throwing.

```ts
try {
  await auth.login({ email, password });
} catch (e) {
  if (e instanceof AuthError) {
    console.log(e.status); // 401
    console.log(e.message); // "Invalid credentials"
  }
}
```

## Sessions

Sessions are stored in a KV namespace (`AUTH_KV`) with a 7-day TTL. The session ID is stored in an `HttpOnly`, `SameSite=Lax` cookie (`__void_session`).

To sign out:

```ts
await auth.logout();
```

This deletes the session from KV and clears the cookie.

## Explicit Configuration

You can configure auth explicitly in `void.json` to override auto-detection:

```json
{
  "inference": {
    "auth": ["github", "google", "email"]
  }
}
```

This enables all three providers. You can also pick a subset:

```json
{ "inference": { "auth": ["github"] } }
```

Or set `true` for email-only:

```json
{ "inference": { "auth": true } }
```

## How It Works

Under the hood, auth is fully code-generated. When auth is enabled, the routing plugin:

1. Provisions a D1 database (`c.env.DB`) and a KV namespace (`c.env.AUTH_KV`) for user and session storage
2. Creates an `auth_users` table in D1 on first request
3. Adds session middleware to the generated Hono app that parses the cookie, looks up the session in KV, and sets `c.get("user")`
4. Generates route handlers for `/auth/*` based on your enabled providers

Passwords are hashed with PBKDF2-SHA256 (310,000 iterations) using the Web Crypto API. OAuth uses [`@hono/oauth-providers`](https://github.com/honojs/middleware/tree/main/packages/oauth-providers) for GitHub and Google.
