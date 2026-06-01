-- Symphony Postgres migration foundation.
-- Intentionally no application tables are created yet; the migration runner
-- creates and maintains symphony_schema_migrations before recording this
-- baseline so future Symphony-owned tables can be added incrementally.
SELECT 1;
