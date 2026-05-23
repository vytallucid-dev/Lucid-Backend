# Prisma — Lucid Backend Database

## How to apply schema changes (Phase 1 init)

### Step 1: Apply Prisma migration
```bash
npm run prisma:generate
npm run prisma:migrate -- --name init
```

### Step 2: Apply manual SQL (partial indexes + auth sync trigger)
Open Supabase Dashboard → SQL Editor → paste contents of `prisma/migrations/manual/001_partial_indexes_and_auth_sync.sql` → Run.

(Alternative: use `psql` with DIRECT_URL.)

### Step 3: Seed reference data
```bash
npm run prisma:seed
```

### Step 4: Verify
```bash
npm run prisma:studio
```

Open Prisma Studio in browser → confirm:
- `assets`: 10 rows
- `indicators`: 13 rows
- `scoring_rules`: 13 rows
- `scorecard_rating_rules`: 1 row
- `users`: 0 rows (populated when first user signs up via Supabase Auth)

## Manual SQL migrations

Prisma's auto-generated migrations don't cover:
- Partial indexes (`WHERE` clauses)
- GIN indexes on arrays
- Postgres functions / triggers
- Cross-schema references (auth.users)

These live in `prisma/migrations/manual/`. Apply each one after the corresponding Prisma migration. Number them sequentially.

## Schema philosophy

- snake_case in DB, camelCase in Prisma client
- All IDs UUID
- All money/financial = Decimal, never Float
- JSONB for flexible metadata (scoring rules, scorecard breakdowns)
- All audit columns (created_at, updated_at) on business tables
- See top-level documentation for full schema design rationale
