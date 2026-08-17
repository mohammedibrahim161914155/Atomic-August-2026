---
skill: database-design
domains: [database, storage, data-modeling, migrations]
applies_to: [planning, production, edge_cases]
priority: high
---

# Database Design Skill

## Schema Conventions (Non-Negotiable)

Every table must have:
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()  -- UUIDv4; prefer UUIDv7 for time-ordering
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
deleted_at  TIMESTAMPTZ NULL  -- soft delete; filter WHERE deleted_at IS NULL
```

Tenant isolation (multi-tenant SaaS):
```sql
tenant_id   UUID NOT NULL REFERENCES tenants(id)
-- Index: CREATE INDEX idx_{table}_tenant ON {table}(tenant_id) WHERE deleted_at IS NULL;
```

## Index Design

| Pattern | When to Use | SQL |
|---------|-------------|-----|
| B-tree | Equality, range, ORDER BY | Default |
| GIN | JSONB, full-text search, arrays | `CREATE INDEX idx_meta ON t USING GIN(metadata)` |
| Partial | Sparse conditions (e.g., active records) | `WHERE deleted_at IS NULL AND status = 'active'` |
| Composite | Multi-column queries (order matters) | Most selective column first |
| Covering | Avoid heap fetches on hot queries | `INCLUDE (col1, col2)` |

## Connection Pooling

- **PostgreSQL**: PgBouncer in transaction mode, max 20 connections per service replica
- **MySQL**: ProxySQL or built-in pool (HikariCP in Java)
- **Never** open a connection per HTTP request
- Pool size formula: `(2 × core_count) + effective_spindle_count` (PGTune starting point)

## Migration Strategy

```sql
-- Always forward-only, no destructive changes in one migration
-- Bad: DROP COLUMN in same migration as data backfill
-- Good:
-- Migration 1: ADD COLUMN new_col (nullable)
-- Migration 2 (deploy + backfill): UPDATE table SET new_col = ...
-- Migration 3 (verify): ALTER TABLE ADD CONSTRAINT NOT NULL
-- Migration 4 (cleanup): DROP COLUMN old_col (only after all traffic is using new_col)
```

Rules:
- Never run migrations in application startup in production
- Always test rollback in staging before applying to production
- Lock-safe: use `ADD COLUMN` over `ADD COLUMN NOT NULL DEFAULT` on large tables (full table rewrite)
- Use `CREATE INDEX CONCURRENTLY` to avoid locking

## Query Patterns

### Pagination (Cursor-Based, recommended for large datasets)
```sql
-- Forward pagination
SELECT * FROM orders
WHERE created_at < :cursor_created_at OR (created_at = :cursor_created_at AND id < :cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT :page_size;
```

### Upsert
```sql
INSERT INTO user_settings (user_id, key, value)
VALUES (:user_id, :key, :value)
ON CONFLICT (user_id, key)
DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

### Avoiding N+1 Queries
```typescript
// Bad: N+1
const orders = await db.orders.findAll();
for (const order of orders) {
  order.items = await db.orderItems.findByOrderId(order.id); // N queries
}

// Good: JOIN or IN clause
const orders = await db.query(`
  SELECT o.*, json_agg(i.*) as items
  FROM orders o
  LEFT JOIN order_items i ON i.order_id = o.id
  WHERE o.tenant_id = $1
  GROUP BY o.id
`, [tenantId]);
```

## Anti-Patterns

- **EAV (Entity-Attribute-Value)**: use JSONB instead for variable attributes
- **Storing comma-separated IDs in a column**: use a junction table
- **No index on foreign keys**: always index FK columns
- **Auto-increment INT as distributed ID**: use UUIDs or ULIDs
- **SELECT *** in production queries**: always name columns explicitly
- **Unbounded queries**: always add LIMIT; use cursor pagination for large datasets
