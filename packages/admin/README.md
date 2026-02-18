# @vite-cloud/admin

Admin dashboard and CLI for Vite Cloud.

## Local Development

### 1. Create `.dev.vars`

Create `packages/admin/.dev.vars` with the required secrets:

```
JWT_SECRET=<same value as platform>
GITHUB_CLIENT_ID=<your GitHub OAuth app client ID>
GITHUB_CLIENT_SECRET=<your GitHub OAuth app client secret>
GOOGLE_CLIENT_ID=<your Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<your Google OAuth client secret>
AUTH_REDIRECT_URI=http://localhost:8788/callback
```

Use the same `JWT_SECRET` as the platform so tokens are interchangeable. You can copy it from `packages/platform/.dev.vars`.

### 2. Apply migrations to local D1

The admin worker shares the platform's D1 database. Apply migrations from the admin package:

```sh
cd packages/admin
wrangler d1 migrations apply vite-cloud-platform --local
```

Or if you've already run the platform locally, the local D1 state is shared (same `database_id`).

### 3. Create a user and promote to admin

The admin dashboard requires a user row with `role = 'admin'` in the database. The easiest way to create one is to log in via the platform CLI first.

#### a) Start the platform locally

```sh
cd packages/platform
pnpm dev
```

This runs the platform API on `http://localhost:8787`. Make sure the platform also has a `.dev.vars` with the same OAuth credentials and `AUTH_REDIRECT_URI=http://localhost:8787/auth/callback`.

#### b) Log in with `vcd login`

From the repo root (or anywhere with `vite-cloud` installed):

```sh
VITE_CLOUD_API_URL=http://localhost:8787 npx vcd login
```

This will:

1. Prompt you to choose GitHub or Google
2. Open your browser to the platform's `/auth/login` endpoint
3. Redirect through the OAuth provider
4. Callback to a temporary local server with your JWT token
5. Save the token to `~/.vite-cloud/credentials.json`

After this, your user row exists in the local D1 database.

#### c) Promote yourself to admin

```sh
cd packages/admin
wrangler d1 execute vite-cloud-platform --local \
  --command "UPDATE users SET role = 'admin' WHERE login = '<your-github-username>'"
```

You can verify it worked:

```sh
wrangler d1 execute vite-cloud-platform --local \
  --command "SELECT id, login, role FROM users"
```

### 4. Start the dev server

```sh
cd packages/admin
pnpm dev
```

This starts wrangler dev on port **8788** (wrangler picks the next available port after 8787 which the platform uses).

To use a specific port:

```sh
pnpm dev --port 8788
```

### 5. Open the dashboard

Visit http://localhost:8788. You'll be redirected to `/login` where you can sign in with GitHub or Google. After OAuth, the callback sets an `admin_token` cookie and redirects to the dashboard.

> **Note:** The OAuth callback redirects to `AUTH_REDIRECT_URI` which must be `http://localhost:8788/callback` for local dev. Make sure this matches your `.dev.vars`.

### Running both platform and admin locally

```sh
# Terminal 1 — platform on :8787
cd packages/platform && pnpm dev

# Terminal 2 — admin on :8788
cd packages/admin && pnpm dev --port 8788
```

## Tests

```sh
# Run admin tests only
pnpm vitest --run packages/admin/

# Run all tests
pnpm vitest --run
```

## CLI (`vca`)

The admin CLI calls the platform's `/admin/*` API endpoints. It reuses the same credentials file as `vcd login` (`~/.vite-cloud/credentials.json`).

```sh
# Point at local platform API
npx tsx src/cli.ts --api-url http://localhost:8787 stats
npx tsx src/cli.ts --api-url http://localhost:8787 users list
npx tsx src/cli.ts --api-url http://localhost:8787 users get <user-id>
npx tsx src/cli.ts --api-url http://localhost:8787 users plan <user-id> pro
```
