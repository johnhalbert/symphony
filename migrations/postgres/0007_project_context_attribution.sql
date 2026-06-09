-- Symphony Postgres schema migration 0007: durable project-context attribution.
--
-- Backward compatibility: legacy single-project rows remain readable through the
-- default project context id/label until runtime dual-write/import arrives.

ALTER TABLE symphony.workspace
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.issue
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.run_session
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.writeback_operation
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.approval_request
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.issue_board_projection
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.history_projection
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.transcript_projection
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

ALTER TABLE symphony.orchestrator_chat_projection
  ADD COLUMN IF NOT EXISTS project_context_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS project_context_label text;

CREATE INDEX IF NOT EXISTS workspace_project_context_idx
  ON symphony.workspace (project_context_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_project_context_idx
  ON symphony.issue (project_context_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS run_session_project_context_idx
  ON symphony.run_session (project_context_id, started_at DESC);
CREATE INDEX IF NOT EXISTS writeback_operation_project_context_idx
  ON symphony.writeback_operation (project_context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_request_project_context_idx
  ON symphony.approval_request (project_context_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS issue_board_projection_project_context_idx
  ON symphony.issue_board_projection (project_context_id, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS history_projection_project_context_idx
  ON symphony.history_projection (project_context_id, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS transcript_projection_project_context_idx
  ON symphony.transcript_projection (project_context_id, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS orchestrator_chat_projection_project_context_idx
  ON symphony.orchestrator_chat_projection (project_context_id, revision DESC, updated_at DESC, generated_at DESC);
