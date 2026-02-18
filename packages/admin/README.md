# @vite-cloud/admin

Admin dashboard and CLI for Vite Cloud.

## Local Development

### 1. Create `.dev.vars`

Create `packages/admin/.dev.vars` with the required secrets:

```
JWT_SECRET=<same value as platform>
GOOGLE_CLIENT_ID=<your Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<your Google OAuth client secret>
AUTH_REDIRECT_URI=http://localhost:8788/callback
```

Use the same `JWT_SECRET` as the platform so tokens are interchangeable. You can copy it from `packages/platform/.dev.vars`.

### 2. Run the setup script

The setup script resets local D1, applies migrations, seeds fake data, and creates your admin user:

```sh
cd packages/admin
pnpm setup
```

The script will prompt for your Google email, then:

- Reset `.wrangler/state/` in both platform and admin packages
- Apply D1 migrations for both workers
- Seed 5 fake users (varied plans), 6 projects, and 8 deployments
- Create an admin user with your Google email (provider_id is backfilled on first login)
- Verify your `.dev.vars` has the required keys

### 3. Start the dev server

```sh
cd packages/admin
pnpm dev
```

This starts wrangler dev on port **8788** (wrangler picks the next available port after 8787 which the platform uses).

To use a specific port:

```sh
pnpm dev --port 8788
```

### 4. Open the dashboard

Visit http://localhost:8788. You'll be redirected to `/login` where you can sign in with Google. After OAuth, the callback sets an `admin_token` cookie and redirects to the dashboard.

> **Note:** The OAuth callback redirects to `AUTH_REDIRECT_URI` which must be `http://localhost:8788/callback` for local dev. Make sure this matches your `.dev.vars`.

### Running both platform and admin locally

The setup script applies migrations for both workers. Then start both:

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
node src/cli.ts --api-url http://localhost:8787 stats
node src/cli.ts --api-url http://localhost:8787 users list
node src/cli.ts --api-url http://localhost:8787 users get <user-id>
node src/cli.ts --api-url http://localhost:8787 users plan <user-id> pro
```

## Production Deployment

Deploy all workers (dispatch, platform with migrations, admin) from the repo root:

```sh
pnpm run deploy
```

Or deploy the admin worker individually:

```sh
cd packages/admin
pnpm run deploy
```

### Secrets

Set the following secrets via `wrangler secret put` before the first deploy:

```sh
cd packages/admin
wrangler secret put JWT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

Use the same `JWT_SECRET` as the platform worker.

`AUTH_REDIRECT_URI` does not need to be set in production — it defaults to `https://admin.vite.cloud/callback` (hardcoded in `login.ts`). The Google OAuth app must have this URL registered as an authorized redirect URI.
