# Auth Playground

Interactive playground for testing the built-in auth system with email/password and OAuth providers.

## Quick Start

```bash
cd playground/auth
pnpm dev
```

Email/password auth works immediately with no setup.

## OAuth Setup

### GitHub

1. Go to **Settings > Developer Settings > OAuth Apps** on GitHub
2. Create a new OAuth App:
   - **Homepage URL**: `http://localhost:5173`
   - **Authorization callback URL**: `http://localhost:5173/auth/login/github`
3. Copy the Client ID and Client Secret into `.env.local`:
   ```
   GITHUB_ID=your_client_id
   GITHUB_SECRET=your_client_secret
   ```

### Google

1. Go to **Google Cloud Console > APIs & Services > Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add authorized redirect URI: `http://localhost:5173/auth/login/google`
4. Copy the Client ID and Client Secret into `.env.local`:
   ```
   GOOGLE_ID=your_client_id
   GOOGLE_SECRET=your_client_secret
   ```

## Generated Routes

| Method | Path                 | Description                    |
| ------ | -------------------- | ------------------------------ |
| POST   | `/auth/register`     | Register with email + password |
| POST   | `/auth/login`        | Login with email + password    |
| GET    | `/auth/me`           | Get current user               |
| POST   | `/auth/logout`       | Clear session                  |
| GET    | `/auth/login/github` | Start GitHub OAuth flow        |
| GET    | `/auth/login/google` | Start Google OAuth flow        |
| GET    | `/api/profile`       | Protected route (requireAuth)  |

## Protected Routes

Use `requireAuth(c)` from `vite-cloud/auth` in any route handler. It returns the current `AuthUser` or throws a 401 error.

```ts
import { defineHandler } from "vite-cloud";
import { requireAuth } from "vite-cloud/auth";

export default defineHandler((c) => {
  const user = requireAuth(c);
  return { user };
});
```

## Resetting State

Delete the `.vite-cloud/` directory to clear all local data (users, sessions, D1 database):

```bash
rm -rf .vite-cloud/
```
