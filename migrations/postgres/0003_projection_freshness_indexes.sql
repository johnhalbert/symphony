-- Symphony Postgres schema migration 0003: projection freshness columns and read indexes.
--
-- 0002_symphony_owned_state.sql is already published and checksum-validated by the
-- migration runner. Keep 0002 immutable and deliver projection updated_at metadata
-- plus replacement read indexes through this follow-up migration so installations
-- that already applied 0002 can upgrade without checksum conflicts.

ALTER TABLE symphony.projection_revision
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE symphony.dashboard_projection
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE symphony.issue_board_projection
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE symphony.sidebar_projection
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE symphony.history_projection
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE symphony.transcript_projection
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE symphony.orchestrator_chat_projection
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP INDEX IF EXISTS symphony.projection_revision_reads_idx;
DROP INDEX IF EXISTS symphony.dashboard_projection_revision_reads_idx;
DROP INDEX IF EXISTS symphony.issue_board_projection_revision_reads_idx;
DROP INDEX IF EXISTS symphony.sidebar_projection_revision_reads_idx;
DROP INDEX IF EXISTS symphony.history_projection_revision_reads_idx;
DROP INDEX IF EXISTS symphony.history_projection_run_lookup_idx;
DROP INDEX IF EXISTS symphony.transcript_projection_revision_reads_idx;
DROP INDEX IF EXISTS symphony.transcript_projection_session_reads_idx;
DROP INDEX IF EXISTS symphony.orchestrator_chat_projection_revision_reads_idx;
DROP INDEX IF EXISTS symphony.orchestrator_chat_projection_issue_idx;

CREATE INDEX IF NOT EXISTS projection_revision_reads_idx
  ON symphony.projection_revision (projection_name, scope_kind, scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS dashboard_projection_revision_reads_idx
  ON symphony.dashboard_projection (scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS issue_board_projection_revision_reads_idx
  ON symphony.issue_board_projection (scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS sidebar_projection_revision_reads_idx
  ON symphony.sidebar_projection (scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS history_projection_revision_reads_idx
  ON symphony.history_projection (scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS history_projection_run_lookup_idx
  ON symphony.history_projection (run_id, session_id, revision DESC, updated_at DESC)
  WHERE run_id IS NOT NULL OR session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transcript_projection_revision_reads_idx
  ON symphony.transcript_projection (run_id, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS transcript_projection_session_reads_idx
  ON symphony.transcript_projection (session_id, revision DESC, updated_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orchestrator_chat_projection_revision_reads_idx
  ON symphony.orchestrator_chat_projection (scope_key, conversation_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS orchestrator_chat_projection_issue_idx
  ON symphony.orchestrator_chat_projection (issue_key, revision DESC, updated_at DESC)
  WHERE issue_key IS NOT NULL;
