-- Symphony Postgres schema migration 0005: durable projection source freshness metadata.
--
-- 0002 created durable projection revision metadata with source revisions and
-- source cursors, and 0003 added projection updated_at freshness ordering. Keep
-- those published migrations checksum-stable and add the per-source freshness
-- projection in this follow-up migration.

ALTER TABLE symphony.projection_revision
  ADD COLUMN IF NOT EXISTS source_freshness jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE symphony.projection_revision
SET source_freshness = CASE
  WHEN source_cursors ? 'sourceFreshness'
    AND jsonb_typeof(source_cursors -> 'sourceFreshness') = 'array'
    THEN source_cursors -> 'sourceFreshness'
  WHEN source_cursors ? 'freshness'
    AND jsonb_typeof(source_cursors -> 'freshness') = 'array'
    THEN source_cursors -> 'freshness'
  ELSE source_freshness
END
WHERE source_freshness = '[]'::jsonb
  AND (source_cursors ? 'sourceFreshness' OR source_cursors ? 'freshness');

DO $$
BEGIN
  ALTER TABLE symphony.projection_revision
    ADD CONSTRAINT projection_revision_source_freshness_array_check
    CHECK (jsonb_typeof(source_freshness) = 'array');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS projection_revision_source_freshness_gin_idx
  ON symphony.projection_revision USING gin (source_freshness jsonb_path_ops);
