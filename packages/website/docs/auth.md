# Authentication

Vite Cloud includes built-in authentication with cookie-based sessions, email/password login, and OAuth providers. Enable it in `vite-cloud.json` and auth routes, session middleware, and a user database are generated automatically.

## Setup

Add the `auth` field to `vite-cloud.json`:

```json
{
  "auth": ["github", "google", "email"]
}
```

This enables all three providers. You can also pick a subset:

```json
{ "auth": ["github"] }
```

Or set `true` for email-only:

```json
{ "auth": true }
```

When auth is enabled, Vite Cloud automatically:

- Provisions a D1 database (`c.env.DB`) and a KV namespace (`c.env.AUTH_KV`) for user and session storage
- Creates an `auth_users` table in D1 on first request
- Adds session middleware that parses the session cookie and sets `c.get("user")` on every request
- Generates auth routes (login, register, logout, OAuth callbacks)

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

Use the `auth` helpers from `vite-cloud/client`:

```ts
import { auth } from "vite-cloud/client";

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

Both methods set a `__vc_session` cookie on success and return the `AuthUser` object. They throw an `AuthError` on failure (wrong credentials, duplicate email, etc.).

### OAuth

For GitHub and Google, link directly to the login route:

```html
<a href="/auth/login/github">Login with GitHub</a>
<a href="/auth/login/google">Login with Google</a>
```

The user is redirected to the provider, then back to your app with a session cookie set.

#### OAuth credentials

OAuth providers require client credentials. Add them to `.dev.vars` for local development:

```
GITHUB_ID=your-github-client-id
GITHUB_SECRET=your-github-client-secret
GOOGLE_ID=your-google-client-id
GOOGLE_SECRET=your-google-client-secret
```

For production, set these as secrets via `wrangler secret put` or in the Vite Cloud dashboard.

## Protecting Routes

Use `requireAuth()` to protect a route. It returns the authenticated user or throws a 401:

```ts
// routes/api/profile.ts
import { defineHandler } from "vite-cloud";
import { requireAuth } from "vite-cloud/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { user };
});
```

For optional auth (don't throw if not logged in), read the user from context directly:

```ts
export const GET = defineHandler((c) => {
  const user = c.get("user"); // AuthUser | null
  return { loggedIn: !!user };
});
```

The session middleware runs on every request and populates `c.get("user")` with the session data (or `null` if not authenticated). `requireAuth()` is a convenience that throws if the value is null.

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

`vite-cloud/client` exports an `auth` object with helpers for all auth operations:

```ts
import { auth, AuthError } from "vite-cloud/client";

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

Sessions are stored in a KV namespace (`AUTH_KV`) with a 7-day TTL. The session ID is stored in an `HttpOnly`, `SameSite=Lax` cookie (`__vc_session`).

To sign out:

```ts
await auth.logout();
```

This deletes the session from KV and clears the cookie.

## How It Works

Under the hood, auth is fully code-generated. When you enable auth, the routing plugin:

1. Adds session middleware to the generated Hono app that parses the cookie, looks up the session in KV, and sets `c.get("user")`
2. Generates route handlers for `/auth/*` based on your enabled providers
3. Auto-provisions the required `DB` and `AUTH_KV` bindings

Passwords are hashed with PBKDF2-SHA256 (310,000 iterations) using the Web Crypto API. OAuth uses [`@hono/oauth-providers`](https://github.com/honojs/middleware/tree/main/packages/oauth-providers) for GitHub and Google.
