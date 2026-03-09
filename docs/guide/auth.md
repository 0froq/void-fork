---
outline: deep
---

# Authentication

Void uses [Better Auth](https://www.better-auth.com/) as the auth engine for Void apps. Void owns the conventions and wiring; Better Auth owns the auth behavior.

## How Auth Turns On

Auth is enabled automatically for Void apps when you:

- import anything from `void/auth`
- import `auth` from `void/client`
- add `auth` to `void.json`
- add a root-level `auth.ts` file

## Defaults

When auth is active, Void configures Better Auth with these conventions:

- mount path: `/api/auth/*`
- email/password enabled by default unless `auth.providers` is set without `"email"`
- `auth.providers` can enable any built-in Better Auth social provider
- social provider credentials come from `AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET`
- D1/SQLite uses the app `DB` binding
- PostgreSQL apps (`"database": "pg"`) use the app `HYPERDRIVE` binding

Auth sessions live in the same database system as the rest of the app. `AUTH_KV` is no longer used.

Example:

```json
{
  "auth": {
    "providers": ["email", "google", "github", "discord"]
  }
}
```

For example, `github` uses `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET`.

## Client Usage

`void/client` now exports a preconfigured Better Auth client:

```ts
import { auth } from "void/client";

await auth.signUp.email({
  email: "alice@example.com",
  password: "s3cret",
  name: "Alice",
});

await auth.signIn.email({
  email: "alice@example.com",
  password: "s3cret",
});

await auth.signOut();
```

The exact client API comes from Better Auth. Void just preconfigures the client with `basePath: "/api/auth"`.

Framework-specific clients are selected automatically:

- React pages apps use `better-auth/react`
- Vue pages apps use `better-auth/vue`
- Svelte pages apps use `better-auth/svelte`
- Solid pages apps use `better-auth/solid`
- other Void apps use `better-auth/client`

For advanced usage, `void/client` also exports `createAuthClient`.

## Server Helpers

`void/auth` keeps the server-side convenience helpers:

```ts
import { getSession, getUser, requireAuth } from "void/auth";
```

- `getUser()` returns the current `AuthUser | null`
- `getSession()` returns `{ user, session } | null`
- `requireAuth(c)` returns the authenticated user or throws `401`

Example:

```ts
import { defineHandler } from "void";
import { requireAuth } from "void/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

### `AuthUser`

`AuthUser` maps to Better Auth's core user type:

```ts
interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

### `AuthSession`

`AuthSession` maps to Better Auth's core session type:

```ts
interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}
```

## Customizing Better Auth

For advanced configuration, create `auth.ts` at the project root and export `defineAuth(...)`:

```ts
import { defineAuth } from "void/auth";

export default defineAuth(({ defaults }) => ({
  ...defaults,
  trustedOrigins: ["https://example.com"],
});
```

`defaults` already includes Void's conventions. Extend it explicitly instead of expecting a deep merge.

## Database and Migrations

Void manages Better Auth migrations as part of the normal Void migration flow:

- local dev bootstraps auth tables automatically
- deploy runs auth migrations together with app migrations
- users do not run a separate Better Auth CLI path

## Unsupported Modes

Void-managed Better Auth is supported only for Cloudflare Void apps in v1.

- meta-framework mode should use Better Auth's official framework integrations directly
- `target: "node" | "bun" | "deno"` should use Better Auth directly
