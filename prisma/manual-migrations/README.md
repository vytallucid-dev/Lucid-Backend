# Manual Migrations

These SQL files contain database changes Prisma can't generate natively:
- Partial indexes
- GIN indexes on arrays
- Postgres functions / triggers
- Cross-schema references
- Data migrations that change rows (not schema)

## Application order

| File | When to apply | Status |
|---|---|---|
| `001_partial_indexes_and_auth_sync.sql` | After Phase 1 `init` migration | Applied |
| `002_iip_to_manual.sql` | After Phase 4 cleanup migration | Pending |

## How to apply

Open Supabase Dashboard → SQL Editor → paste contents → Run.

Or via psql with `DIRECT_URL`:

```bash
psql "$DIRECT_URL" -f prisma/manual-migrations/002_iip_to_manual.sql
```

## Idempotency

All files use `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, or value-checking WHERE clauses where possible. Re-running should be safe.
