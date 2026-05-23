# Lucid Backend

Backend for Lucid NIFTY tool and EdgeFinder forex tool. Node.js + Express + TypeScript + Prisma + Supabase Postgres + Supabase Auth.

## Setup

### 1. Create Supabase project

1. Go to https://supabase.com → New Project
2. Pick a strong DB password (save it)
3. Pick a region close to you (Mumbai recommended)
4. Wait for provisioning (~2 min)
5. Settings → Database → Connection String:
   - **Transaction pooler** (port 6543, with `?pgbouncer=true`) → `DATABASE_URL`
   - **Session pooler / direct** (port 5432) → `DIRECT_URL`

### 2. Configure Supabase Auth

In the Supabase dashboard:

1. Authentication → Providers → **Email**: enable
   - Email confirmations: **ON**
   - Minimum password length: **8** or higher
   - Secure email change: **ON**
   - Secure password change: **ON**
2. Authentication → URL Configuration:
   - Site URL: your frontend production URL (or `http://localhost:3000` for dev)
   - Redirect URLs: include localhost variants for development
3. Project Settings → API: copy these three values into your `.env`:
   - `SUPABASE_URL` (e.g., `https://xxxxx.supabase.co`)
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` — **server-only secret**

### 3. Get FRED API key

Free, instant: https://fred.stlouisfed.org/docs/api/api_key.html

### 4. Local setup

```bash
cp .env.example .env
# Fill in DATABASE_URL, DIRECT_URL, SUPABASE_URL, SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, FRED_API_KEY

npm install
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

### 5. Verify

- `GET http://localhost:3001/health` → `{ status: 'ok' }`
- `GET http://localhost:3001/ready` → `{ status: 'ready' }`
- `GET http://localhost:3001/api/admin/ping` with `Authorization: Bearer <admin-jwt>` → success

## Authentication

Every protected route requires a Supabase-issued JWT in the `Authorization: Bearer <token>` header. There is no static API key fallback.

| Route prefix | Required |
|---|---|
| `/api/oracle/*`, `/api/nifty/*` | Valid JWT (any authenticated user) |
| `/api/admin/*` | Valid JWT **and** `app_metadata.role = 'admin'` |

JWTs are verified against Supabase's JWKS endpoint (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`), with `audience=authenticated` and `issuer=${SUPABASE_URL}/auth/v1`. Signature, expiry, audience, and issuer are all checked. Any failure returns a generic `401 UNAUTHORIZED` — the specific reason is logged server-side only and never sent to the client.

### Bootstrap your first admin

1. **Run the migration** (installs `auth.users → public.users` sync triggers):
   ```bash
   npm run prisma:migrate:deploy
   ```
   Confirm the triggers landed:
   ```sql
   SELECT tgname FROM pg_trigger
   WHERE tgname IN ('on_auth_user_created', 'on_auth_user_email_changed');
   ```
2. **Create your user**: Supabase dashboard → Authentication → Users → "Add user" (or sign up via the frontend / a `@supabase/supabase-js` script). Verify the mirror:
   ```sql
   SELECT id, email, role FROM public.users ORDER BY created_at DESC LIMIT 5;
   ```
   A row should appear with `role = 'user'`.
3. **Promote to admin**: dashboard → Authentication → Users → edit your user → set `Raw App Meta Data` to `{"role": "admin"}` → save. Log in again to mint a fresh JWT carrying the new role.
4. **Test a protected endpoint**:
   ```bash
   curl -H "Authorization: Bearer <your-jwt>" http://localhost:3001/api/oracle/assets
   curl -H "Authorization: Bearer <your-admin-jwt>" -H "Content-Type: application/json" \
        -X POST http://localhost:3001/api/admin/jobs/run \
        -d '{"job_name":"compass_input_fetch"}'
   ```

### Getting a JWT for local testing

The easiest way is a tiny Node script using `@supabase/supabase-js`:

```ts
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const { data } = await sb.auth.signInWithPassword({
  email: 'you@example.com',
  password: '...',
});
console.log(data.session?.access_token);
```

## Architecture

- `src/core/` — shared across both products
- `src/modules/nifty/` — NIFTY-specific
- `src/modules/edgefinder/` — EdgeFinder-specific
- `src/config/` — env, constants

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm run prisma:migrate` | Create + apply migration |
| `npm run prisma:studio` | Visual DB browser |
| `npm test` | Run tests |

## Job triggers

Every cron job has a manual trigger endpoint under `/api/admin/jobs/*`. Authenticate with an admin JWT — `Authorization: Bearer <admin-jwt>`.
