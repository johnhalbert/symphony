-- Symphony Postgres schema migration 0006: durable projection build mode metadata.
--
-- Distinguish initial bootstrap rows, on-demand incremental/read-repair rows,
-- and explicit rebuild/backfill rows without changing the published 0002
-- projection_revision checksum.

ALTER TABLE symphony.projection_revision
  ADD COLUMN IF NOT EXISTS build_mode text NOT NULL DEFAULT 'incremental';

UPDATE symphony.projection_revision
SET build_mode = CASE
  WHEN revision = 1 THEN 'bootstrap'
  ELSE build_mode
END
WHERE build_mode = 'incremental';

DO $$
BEGIN
  ALTER TABLE symphony.projection_revision
    ADD CONSTRAINT projection_revision_build_mode_check
    CHECK (build_mode IN ('bootstrap', 'incremental', 'rebuild'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS projection_revision_build_mode_idx
  ON symphony.projection_revision (build_mode, projection_name, updated_at DESC, generated_at DESC);

COMMENT ON COLUMN symphony.projection_revision.build_mode IS
  'How the durable projection revision was produced: bootstrap for first scope materialization, incremental for on-demand/read-repair updates, or rebuild for explicit rebuild/backfill writes.';
