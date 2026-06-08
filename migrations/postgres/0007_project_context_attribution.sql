-- Symphony Postgres schema migration 0007: project-context attribution for multi-project routing.
--
-- 0002 established the owned workspace/issue/run-session tables before Symphony could
-- route the same tracker identifier through multiple configured project contexts.
-- Keep the published 0002 checksum stable and add explicit project-context columns and
-- lookup indexes here so Postgres-backed reads can separate overlapping identifiers.

ALTER TABLE symphony.workspace
  ADD COLUMN IF NOT EXISTS project_context_id text,
  ADD COLUMN IF NOT EXISTS project_context_label text,
  ADD COLUMN IF NOT EXISTS tracker_project_slug text;

ALTER TABLE symphony.issue
  ADD COLUMN IF NOT EXISTS project_context_id text,
  ADD COLUMN IF NOT EXISTS project_context_label text,
  ADD COLUMN IF NOT EXISTS tracker_project_slug text;

ALTER TABLE symphony.run_session
  ADD COLUMN IF NOT EXISTS project_context_id text,
  ADD COLUMN IF NOT EXISTS project_context_label text,
  ADD COLUMN IF NOT EXISTS tracker_project_slug text;

CREATE INDEX IF NOT EXISTS workspace_project_context_lookup_idx
  ON symphony.workspace (project_context_id, issue_identifier, updated_at DESC);

CREATE INDEX IF NOT EXISTS issue_project_context_lookup_idx
  ON symphony.issue (tracker_source, project_context_id, issue_identifier, updated_at DESC);

CREATE INDEX IF NOT EXISTS run_session_project_context_issue_idx
  ON symphony.run_session (project_context_id, issue_identifier, started_at DESC);

CREATE INDEX IF NOT EXISTS run_session_project_context_workspace_idx
  ON symphony.run_session (project_context_id, workspace_key, started_at DESC);

COMMENT ON COLUMN symphony.workspace.project_context_id IS
  'Resolved Symphony project_contexts.id for this workspace/worktree routing record when multi-project workflows are enabled.';
COMMENT ON COLUMN symphony.workspace.project_context_label IS
  'Operator-facing project context label captured with the workspace routing snapshot.';
COMMENT ON COLUMN symphony.workspace.tracker_project_slug IS
  'Tracker project slug snapshot used to route the workspace issue when the tracker supports project scoping.';

COMMENT ON COLUMN symphony.issue.project_context_id IS
  'Resolved Symphony project_contexts.id for this durable issue/lifecycle record.';
COMMENT ON COLUMN symphony.issue.project_context_label IS
  'Operator-facing project context label captured with the issue/lifecycle snapshot.';
COMMENT ON COLUMN symphony.issue.tracker_project_slug IS
  'Tracker project slug snapshot used to resolve the issue inside multi-project tracker polling and writeback flows.';

COMMENT ON COLUMN symphony.run_session.project_context_id IS
  'Resolved Symphony project_contexts.id for this run/session so overlapping identifiers can be disambiguated during history, transcript, and writeback reads.';
COMMENT ON COLUMN symphony.run_session.project_context_label IS
  'Operator-facing project context label captured with the run/session snapshot.';
COMMENT ON COLUMN symphony.run_session.tracker_project_slug IS
  'Tracker project slug snapshot used for this run/session when the tracker supports project scoping.';
