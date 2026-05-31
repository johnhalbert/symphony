# Postgres migrations

Postgres migrations live in this directory and are applied in filename order with the
`NNNN_description.sql` naming convention. The migration runner stores applied
checksums in `symphony_schema_migrations` inside the target database.

Common development commands:

- `npm run migrations:validate -- WORKFLOW.md` checks discovery and ordering
  without opening a database connection.
- `npm run migrations:apply -- WORKFLOW.md` applies migrations when
  `database.postgres.url` or `SYMPHONY_POSTGRES_URL` is configured.

The database URL is optional. When it is unset, normal file-backed Symphony
startup continues to use the existing stores, and migrations are only validated
or applied when these commands are run explicitly.
