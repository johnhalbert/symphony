-- Symphony Postgres schema migration 0007: project-context attribution.
--
-- 0002_symphony_owned_state.sql and follow-up migrations 0003-0006 are already
-- published and checksum-validated by the migration runner. Keep those files
-- immutable and add context attribution through this follow-up migration so
-- existing databases can upgrade without checksum conflicts while preserving the
-- legacy/default single-project behavior for callers that do not yet supply an
-- explicit project context.

ALTER TABLE symphony.workspace
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.issue
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.run_session
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.run_session
  ADD COLUMN IF NOT EXISTS project_context_label text;
ALTER TABLE symphony.run_session
  ADD COLUMN IF NOT EXISTS linear_project_identity jsonb;
ALTER TABLE symphony.run_session
  ADD COLUMN IF NOT EXISTS codebase_identity jsonb;
ALTER TABLE symphony.run_session
  ADD COLUMN IF NOT EXISTS routing_source text;
ALTER TABLE symphony.run_activity_event
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.chat_message
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.writeback_operation
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.approval_request
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.projection_revision
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.dashboard_projection
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.issue_board_projection
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.sidebar_projection
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.history_projection
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.transcript_projection
  ADD COLUMN IF NOT EXISTS project_context_id text;
ALTER TABLE symphony.orchestrator_chat_projection
  ADD COLUMN IF NOT EXISTS project_context_id text;

UPDATE symphony.workspace
SET project_context_id = 'default'
WHERE project_context_id IS NULL OR btrim(project_context_id) = '';

UPDATE symphony.issue
SET project_context_id = 'default'
WHERE project_context_id IS NULL OR btrim(project_context_id) = '';

UPDATE symphony.run_session
SET project_context_id = COALESCE(NULLIF(btrim(project_context_id), ''), 'default'),
    project_context_label = COALESCE(NULLIF(btrim(project_context_label), ''), 'Default'),
    linear_project_identity = COALESCE(
      linear_project_identity,
      jsonb_build_object(
        'issueKey', issue_key,
        'externalIssueId', external_issue_id,
        'issueIdentifier', issue_identifier
      )
    ),
    codebase_identity = COALESCE(
      codebase_identity,
      jsonb_build_object(
        'workspaceKey', workspace_key,
        'workspacePath', workspace_path,
        'repoPath', repo_path,
        'baseRef', base_ref
      )
    ),
    routing_source = COALESCE(NULLIF(btrim(routing_source), ''), 'legacy_default')
WHERE project_context_id IS NULL
   OR btrim(project_context_id) = ''
   OR project_context_label IS NULL
   OR btrim(project_context_label) = ''
   OR linear_project_identity IS NULL
   OR codebase_identity IS NULL
   OR routing_source IS NULL
   OR btrim(routing_source) = '';

UPDATE symphony.run_activity_event event
SET project_context_id = run.project_context_id
FROM symphony.run_session run
WHERE run.run_id = event.run_id
  AND (event.project_context_id IS NULL OR btrim(event.project_context_id) = '');

UPDATE symphony.chat_message message
SET project_context_id = COALESCE(
  (
    SELECT run.project_context_id
    FROM symphony.run_session run
    WHERE run.run_id = message.run_id
    LIMIT 1
  ),
  (
    SELECT issue.project_context_id
    FROM symphony.issue issue
    WHERE issue.issue_key = message.issue_key
    LIMIT 1
  ),
  'default'
)
WHERE message.project_context_id IS NULL OR btrim(message.project_context_id) = '';

UPDATE symphony.writeback_operation operation
SET project_context_id = COALESCE(
  (
    SELECT run.project_context_id
    FROM symphony.run_session run
    WHERE run.run_id = operation.run_id
    LIMIT 1
  ),
  (
    SELECT issue.project_context_id
    FROM symphony.issue issue
    WHERE issue.issue_key = operation.issue_key
    LIMIT 1
  ),
  'default'
)
WHERE operation.project_context_id IS NULL OR btrim(operation.project_context_id) = '';

UPDATE symphony.approval_request approval
SET project_context_id = COALESCE(
  (
    SELECT run.project_context_id
    FROM symphony.run_session run
    WHERE run.run_id = approval.run_id
    LIMIT 1
  ),
  (
    SELECT issue.project_context_id
    FROM symphony.issue issue
    WHERE issue.issue_key = approval.issue_key
    LIMIT 1
  ),
  'default'
)
WHERE approval.project_context_id IS NULL OR btrim(approval.project_context_id) = '';

UPDATE symphony.projection_revision
SET project_context_id = 'default'
WHERE project_context_id IS NULL OR btrim(project_context_id) = '';

UPDATE symphony.dashboard_projection child
SET project_context_id = COALESCE(
  (
    SELECT revision.project_context_id
    FROM symphony.projection_revision revision
    WHERE revision.projection_revision_id = child.projection_revision_id
  ),
  'default'
)
WHERE child.project_context_id IS NULL OR btrim(child.project_context_id) = '';

UPDATE symphony.issue_board_projection child
SET project_context_id = COALESCE(
  (
    SELECT revision.project_context_id
    FROM symphony.projection_revision revision
    WHERE revision.projection_revision_id = child.projection_revision_id
  ),
  'default'
)
WHERE child.project_context_id IS NULL OR btrim(child.project_context_id) = '';

UPDATE symphony.sidebar_projection child
SET project_context_id = COALESCE(
  (
    SELECT revision.project_context_id
    FROM symphony.projection_revision revision
    WHERE revision.projection_revision_id = child.projection_revision_id
  ),
  'default'
)
WHERE child.project_context_id IS NULL OR btrim(child.project_context_id) = '';

UPDATE symphony.history_projection child
SET project_context_id = COALESCE(
  (
    SELECT revision.project_context_id
    FROM symphony.projection_revision revision
    WHERE revision.projection_revision_id = child.projection_revision_id
  ),
  'default'
)
WHERE child.project_context_id IS NULL OR btrim(child.project_context_id) = '';

UPDATE symphony.transcript_projection child
SET project_context_id = COALESCE(
  (
    SELECT revision.project_context_id
    FROM symphony.projection_revision revision
    WHERE revision.projection_revision_id = child.projection_revision_id
  ),
  'default'
)
WHERE child.project_context_id IS NULL OR btrim(child.project_context_id) = '';

UPDATE symphony.orchestrator_chat_projection child
SET project_context_id = COALESCE(
  (
    SELECT revision.project_context_id
    FROM symphony.projection_revision revision
    WHERE revision.projection_revision_id = child.projection_revision_id
  ),
  'default'
)
WHERE child.project_context_id IS NULL OR btrim(child.project_context_id) = '';

ALTER TABLE symphony.workspace
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.workspace
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.issue
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.issue
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.run_session
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.run_session
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.run_session
  ALTER COLUMN project_context_label SET DEFAULT 'Default';
ALTER TABLE symphony.run_session
  ALTER COLUMN project_context_label SET NOT NULL;
ALTER TABLE symphony.run_session
  ALTER COLUMN linear_project_identity SET DEFAULT '{}'::jsonb;
ALTER TABLE symphony.run_session
  ALTER COLUMN linear_project_identity SET NOT NULL;
ALTER TABLE symphony.run_session
  ALTER COLUMN codebase_identity SET DEFAULT '{}'::jsonb;
ALTER TABLE symphony.run_session
  ALTER COLUMN codebase_identity SET NOT NULL;
ALTER TABLE symphony.run_session
  ALTER COLUMN routing_source SET DEFAULT 'legacy_default';
ALTER TABLE symphony.run_session
  ALTER COLUMN routing_source SET NOT NULL;
ALTER TABLE symphony.run_activity_event
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.run_activity_event
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.chat_message
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.chat_message
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.writeback_operation
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.writeback_operation
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.approval_request
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.approval_request
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.projection_revision
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.projection_revision
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.dashboard_projection
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.dashboard_projection
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.issue_board_projection
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.issue_board_projection
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.sidebar_projection
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.sidebar_projection
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.history_projection
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.history_projection
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.transcript_projection
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.transcript_projection
  ALTER COLUMN project_context_id SET NOT NULL;
ALTER TABLE symphony.orchestrator_chat_projection
  ALTER COLUMN project_context_id SET DEFAULT 'default';
ALTER TABLE symphony.orchestrator_chat_projection
  ALTER COLUMN project_context_id SET NOT NULL;

ALTER TABLE symphony.run_activity_event
  DROP CONSTRAINT IF EXISTS run_activity_event_run_id_fkey;
ALTER TABLE symphony.chat_message
  DROP CONSTRAINT IF EXISTS chat_message_run_id_fkey;

ALTER TABLE symphony.workspace
  DROP CONSTRAINT IF EXISTS workspace_pkey;
ALTER TABLE symphony.workspace
  ADD PRIMARY KEY (project_context_id, workspace_key);

ALTER TABLE symphony.issue
  DROP CONSTRAINT IF EXISTS issue_pkey;
ALTER TABLE symphony.issue
  ADD PRIMARY KEY (project_context_id, issue_key);
DROP INDEX IF EXISTS symphony.issue_identifier_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS issue_identifier_unique_idx
  ON symphony.issue (project_context_id, tracker_source, issue_identifier);

ALTER TABLE symphony.run_session
  DROP CONSTRAINT IF EXISTS run_session_pkey;
ALTER TABLE symphony.run_session
  ADD PRIMARY KEY (project_context_id, run_id);

ALTER TABLE symphony.run_activity_event
  DROP CONSTRAINT IF EXISTS run_activity_event_run_session_id_sequence_key;
ALTER TABLE symphony.run_activity_event
  ADD CONSTRAINT run_activity_event_run_session_id_sequence_key UNIQUE (project_context_id, run_session_id, sequence);
DROP INDEX IF EXISTS symphony.run_activity_event_external_event_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS run_activity_event_external_event_unique_idx
  ON symphony.run_activity_event (project_context_id, run_session_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

ALTER TABLE symphony.chat_message
  DROP CONSTRAINT IF EXISTS chat_message_message_id_key;
ALTER TABLE symphony.chat_message
  ADD CONSTRAINT chat_message_message_id_key UNIQUE (project_context_id, message_id);
ALTER TABLE symphony.chat_message
  DROP CONSTRAINT IF EXISTS chat_message_thread_key_message_index_key;
ALTER TABLE symphony.chat_message
  ADD CONSTRAINT chat_message_thread_key_message_index_key UNIQUE (project_context_id, thread_key, message_index);

ALTER TABLE symphony.writeback_operation
  DROP CONSTRAINT IF EXISTS writeback_operation_pkey;
ALTER TABLE symphony.writeback_operation
  ADD PRIMARY KEY (project_context_id, idempotency_key);

ALTER TABLE symphony.approval_request
  DROP CONSTRAINT IF EXISTS approval_request_pkey;
ALTER TABLE symphony.approval_request
  ADD PRIMARY KEY (project_context_id, request_id);
ALTER TABLE symphony.approval_request
  DROP CONSTRAINT IF EXISTS approval_request_dedupe_key_key;
ALTER TABLE symphony.approval_request
  ADD CONSTRAINT approval_request_dedupe_key_key UNIQUE (project_context_id, dedupe_key);

ALTER TABLE symphony.run_activity_event
  ADD CONSTRAINT run_activity_event_run_context_fkey
  FOREIGN KEY (project_context_id, run_id)
  REFERENCES symphony.run_session (project_context_id, run_id)
  ON DELETE CASCADE;
ALTER TABLE symphony.chat_message
  ADD CONSTRAINT chat_message_run_context_fkey
  FOREIGN KEY (project_context_id, run_id)
  REFERENCES symphony.run_session (project_context_id, run_id)
  ON DELETE SET NULL (run_id);

DROP INDEX IF EXISTS symphony.run_session_lookup_idx;
DROP INDEX IF EXISTS symphony.issue_status_lookup_idx;
DROP INDEX IF EXISTS symphony.issue_phase_lookup_idx;
DROP INDEX IF EXISTS symphony.run_session_issue_status_idx;
DROP INDEX IF EXISTS symphony.run_session_identifier_started_idx;
DROP INDEX IF EXISTS symphony.run_session_workspace_idx;
DROP INDEX IF EXISTS symphony.run_activity_event_ordering_idx;
DROP INDEX IF EXISTS symphony.run_activity_event_run_ordering_idx;
DROP INDEX IF EXISTS symphony.run_activity_event_time_ordering_idx;
DROP INDEX IF EXISTS symphony.chat_message_ordering_idx;
DROP INDEX IF EXISTS symphony.chat_message_issue_ordering_idx;
DROP INDEX IF EXISTS symphony.chat_message_run_ordering_idx;
DROP INDEX IF EXISTS symphony.chat_message_event_range_idx;
DROP INDEX IF EXISTS symphony.writeback_operation_state_idx;
DROP INDEX IF EXISTS symphony.writeback_operation_issue_idx;
DROP INDEX IF EXISTS symphony.writeback_operation_run_idx;
DROP INDEX IF EXISTS symphony.approval_request_state_idx;
DROP INDEX IF EXISTS symphony.approval_request_issue_idx;
DROP INDEX IF EXISTS symphony.approval_request_run_idx;

CREATE INDEX IF NOT EXISTS issue_status_lookup_idx
  ON symphony.issue (project_context_id, tracker_source, tracker_state, phase, updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_phase_lookup_idx
  ON symphony.issue (project_context_id, phase, blocked_reason, updated_at DESC);
CREATE INDEX IF NOT EXISTS run_session_lookup_idx
  ON symphony.run_session (project_context_id, session_id, run_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_session_issue_status_idx
  ON symphony.run_session (project_context_id, issue_key, status, started_at DESC);
CREATE INDEX IF NOT EXISTS run_session_identifier_started_idx
  ON symphony.run_session (project_context_id, issue_identifier, started_at DESC);
CREATE INDEX IF NOT EXISTS run_session_workspace_idx
  ON symphony.run_session (project_context_id, workspace_key, started_at DESC);
CREATE INDEX IF NOT EXISTS run_activity_event_ordering_idx
  ON symphony.run_activity_event (project_context_id, run_session_id, sequence);
CREATE INDEX IF NOT EXISTS run_activity_event_run_ordering_idx
  ON symphony.run_activity_event (project_context_id, run_id, run_session_id, sequence);
CREATE INDEX IF NOT EXISTS run_activity_event_time_ordering_idx
  ON symphony.run_activity_event (project_context_id, run_session_id, event_at, sequence);
CREATE INDEX IF NOT EXISTS chat_message_ordering_idx
  ON symphony.chat_message (project_context_id, thread_key, message_index);
CREATE INDEX IF NOT EXISTS chat_message_issue_ordering_idx
  ON symphony.chat_message (project_context_id, issue_key, created_at, message_index);
CREATE INDEX IF NOT EXISTS chat_message_run_ordering_idx
  ON symphony.chat_message (project_context_id, run_id, message_index)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_message_event_range_idx
  ON symphony.chat_message (project_context_id, run_id, event_sequence_start, event_sequence_end)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS writeback_operation_state_idx
  ON symphony.writeback_operation (project_context_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS writeback_operation_issue_idx
  ON symphony.writeback_operation (project_context_id, issue_key, created_at DESC);
CREATE INDEX IF NOT EXISTS writeback_operation_run_idx
  ON symphony.writeback_operation (project_context_id, run_id, created_at DESC)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_request_state_idx
  ON symphony.approval_request (project_context_id, status, expires_at, requested_at);
CREATE INDEX IF NOT EXISTS approval_request_issue_idx
  ON symphony.approval_request (project_context_id, issue_key, requested_at DESC);
CREATE INDEX IF NOT EXISTS approval_request_run_idx
  ON symphony.approval_request (project_context_id, run_id, requested_at DESC);

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname
  INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'symphony'
    AND t.relname = 'projection_revision'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) ILIKE 'UNIQUE (projection_name, scope_kind, scope_key, revision)%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE symphony.projection_revision DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

DROP INDEX IF EXISTS symphony.projection_revision_current_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS projection_revision_current_unique_idx
  ON symphony.projection_revision (project_context_id, projection_name, scope_kind, scope_key)
  WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projection_revision_scope_revision_unique_idx
  ON symphony.projection_revision (project_context_id, projection_name, scope_kind, scope_key, revision);

DROP INDEX IF EXISTS symphony.dashboard_projection_scope_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_projection_scope_revision_idx
  ON symphony.dashboard_projection (project_context_id, scope_key, revision);
DROP INDEX IF EXISTS symphony.issue_board_projection_scope_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS issue_board_projection_scope_revision_idx
  ON symphony.issue_board_projection (project_context_id, scope_key, revision);
DROP INDEX IF EXISTS symphony.sidebar_projection_scope_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sidebar_projection_scope_revision_idx
  ON symphony.sidebar_projection (project_context_id, scope_key, revision);
DROP INDEX IF EXISTS symphony.history_projection_scope_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS history_projection_scope_revision_idx
  ON symphony.history_projection (project_context_id, scope_key, revision);
DROP INDEX IF EXISTS symphony.transcript_projection_scope_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS transcript_projection_scope_revision_idx
  ON symphony.transcript_projection (project_context_id, scope_key, revision);
DROP INDEX IF EXISTS symphony.orchestrator_chat_projection_scope_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_chat_projection_scope_revision_idx
  ON symphony.orchestrator_chat_projection (project_context_id, scope_key, conversation_key, revision);

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
  ON symphony.projection_revision (project_context_id, projection_name, scope_kind, scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS dashboard_projection_revision_reads_idx
  ON symphony.dashboard_projection (project_context_id, scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS issue_board_projection_revision_reads_idx
  ON symphony.issue_board_projection (project_context_id, scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS sidebar_projection_revision_reads_idx
  ON symphony.sidebar_projection (project_context_id, scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS history_projection_revision_reads_idx
  ON symphony.history_projection (project_context_id, scope_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS history_projection_run_lookup_idx
  ON symphony.history_projection (project_context_id, run_id, session_id, revision DESC)
  WHERE run_id IS NOT NULL OR session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transcript_projection_revision_reads_idx
  ON symphony.transcript_projection (project_context_id, run_id, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS transcript_projection_session_reads_idx
  ON symphony.transcript_projection (project_context_id, session_id, revision DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orchestrator_chat_projection_revision_reads_idx
  ON symphony.orchestrator_chat_projection (project_context_id, scope_key, conversation_key, revision DESC, updated_at DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS orchestrator_chat_projection_issue_idx
  ON symphony.orchestrator_chat_projection (project_context_id, issue_key, revision DESC)
  WHERE issue_key IS NOT NULL;
