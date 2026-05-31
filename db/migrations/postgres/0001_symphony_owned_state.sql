-- Symphony Postgres schema migration 0001: owned operational state and durable projections.
--
-- Source-of-truth boundary: Linear, GitHub, git worktrees, runtime harnesses,
-- and external agent sessions remain external authorities. Symphony persists only
-- local snapshots, cursors, correlations, normalized events, writeback/approval
-- operation state, and frontend read-model projections derived from those sources.
--
-- Transition boundary: this migration is additive and introduces no runtime config
-- switch. Existing file-backed JSON/JSONL state remains the active runtime
-- persistence path until a later repository layer explicitly dual-writes or imports
-- into these tables.
--
-- Oversized harness payload policy: inline JSONB fields below are for normalized,
-- redacted, size-capped payloads and projection payloads. Raw harness payloads that
-- exceed the inline cap, contain bulky tool output, or need byte-for-byte retention
-- must be written to controlled object/file storage and represented by
-- symphony.raw_payload_reference rows plus *_raw_payload_ref_id/raw_payload_refs
-- pointers. Projection JSON must not blindly embed unbounded raw harness output.

BEGIN;

CREATE SCHEMA IF NOT EXISTS symphony;

CREATE TABLE IF NOT EXISTS symphony.raw_payload_reference (
  raw_payload_ref_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_table text NOT NULL,
  owner_key text NOT NULL,
  storage_uri text NOT NULL,
  sha256 text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  media_type text NOT NULL DEFAULT 'application/json',
  compression text,
  redaction_status text NOT NULL DEFAULT 'unknown' CHECK (redaction_status IN ('unknown', 'redacted', 'not_required')),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (storage_uri),
  UNIQUE (sha256, byte_length)
);

COMMENT ON TABLE symphony.raw_payload_reference IS
  'References oversized raw harness/runtime payloads stored outside projection JSON. Inline JSONB remains normalized, redacted, and size-capped.';
COMMENT ON COLUMN symphony.raw_payload_reference.storage_uri IS
  'Controlled file/object-storage URI for the raw payload. Do not store credentials or connection strings in this value.';

CREATE TABLE IF NOT EXISTS symphony.workspace (
  workspace_key text PRIMARY KEY,
  issue_key text,
  external_issue_id text,
  issue_identifier text NOT NULL,
  path text NOT NULL,
  source_kind text NOT NULL,
  repo_path text,
  base_ref text,
  git_branch_name text,
  branch_name text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (created_at <= updated_at)
);

COMMENT ON TABLE symphony.workspace IS
  'Symphony-owned snapshot of local workspace/worktree routing. The git worktree remains the authority for repository contents and filesystem state.';

CREATE TABLE IF NOT EXISTS symphony.issue (
  issue_key text PRIMARY KEY,
  tracker_source text NOT NULL DEFAULT 'linear',
  external_issue_id text,
  issue_identifier text NOT NULL,
  title_snapshot text,
  description_snapshot text,
  tracker_state text,
  tracker_state_classification text,
  priority_snapshot integer,
  labels_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  blockers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  tracker_url text,
  tracker_created_at timestamptz,
  tracker_updated_at timestamptz,
  tracker_fetched_at timestamptz,
  phase text NOT NULL DEFAULT 'unknown' CHECK (phase IN ('implementation', 'merge_conflict_resolution', 'review', 'passed', 'blocked', 'terminal', 'unknown')),
  blocked_reason text,
  review_round integer NOT NULL DEFAULT 0 CHECK (review_round >= 0),
  incomplete_turn_count integer NOT NULL DEFAULT 0 CHECK (incomplete_turn_count >= 0),
  planning_failure_count integer NOT NULL DEFAULT 0 CHECK (planning_failure_count >= 0),
  planning_dispatch_retry_count integer NOT NULL DEFAULT 0 CHECK (planning_dispatch_retry_count >= 0),
  last_run_id text,
  last_completion_report_id text,
  last_review_verdict_id text,
  summary_pointers jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  handoff jsonb NOT NULL DEFAULT '{}'::jsonb,
  merge_gate jsonb,
  merge_metadata jsonb,
  merge_conflict jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(labels_snapshot) = 'array'),
  CHECK (jsonb_typeof(blockers_snapshot) = 'array'),
  CHECK (created_at <= updated_at)
);

COMMENT ON TABLE symphony.issue IS
  'Symphony-owned issue lifecycle/projection snapshot. Linear remains authoritative for tracker issue fields; Symphony owns local phase, counters, handoff summaries, and correlation pointers.';

CREATE UNIQUE INDEX IF NOT EXISTS issue_external_issue_id_unique_idx
  ON symphony.issue (tracker_source, external_issue_id)
  WHERE external_issue_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS issue_identifier_unique_idx
  ON symphony.issue (tracker_source, issue_identifier);
CREATE INDEX IF NOT EXISTS issue_status_lookup_idx
  ON symphony.issue (tracker_source, tracker_state, phase, updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_phase_lookup_idx
  ON symphony.issue (phase, blocked_reason, updated_at DESC);

CREATE TABLE IF NOT EXISTS symphony.run_session (
  run_id text PRIMARY KEY,
  session_id text,
  agent_id text,
  role text NOT NULL CHECK (role IN ('worker', 'reviewer', 'planner', 'merge_conflict_resolver')),
  run_phase text NOT NULL DEFAULT 'implementation',
  run_kind text NOT NULL DEFAULT 'implementation',
  issue_key text NOT NULL,
  external_issue_id text,
  issue_identifier text NOT NULL,
  workspace_key text NOT NULL,
  workspace_path text NOT NULL,
  attempt integer CHECK (attempt IS NULL OR attempt >= 0),
  turn_number integer NOT NULL CHECK (turn_number >= 0),
  prompt_preview text NOT NULL DEFAULT '',
  prompt_char_count integer NOT NULL DEFAULT 0 CHECK (prompt_char_count >= 0),
  harness_id text,
  runtime_model text,
  runtime_model_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  runtime_setting_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  runtime_mode text,
  runtime_allow_large_context boolean,
  runtime_agent_lifecycle text,
  cursor_model text,
  cursor_model_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  cursor_setting_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  cursor_mode text,
  cursor_allow_large_context boolean,
  cursor_worker_agent_lifecycle text,
  git_branch_name text,
  repo_path text,
  base_ref text,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  error text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  transcript_event_count integer NOT NULL DEFAULT 0 CHECK (transcript_event_count >= 0),
  pr_url text,
  pr_number integer,
  pr_head_sha text,
  pr_branch text,
  ci_status text,
  last_pushed_at timestamptz,
  last_evidence_cursor text,
  cancellation_requested_at timestamptz,
  cancellation_source text CHECK (cancellation_source IS NULL OR cancellation_source IN ('operator', 'state_change', 'stalled', 'service_stop')),
  cancellation_reason text,
  harness_stop_requested_at timestamptz,
  harness_stop_failed_at timestamptz,
  harness_stop_failed_reason text,
  cancellation_outcome text CHECK (cancellation_outcome IS NULL OR cancellation_outcome IN ('none', 'requested', 'cancelled', 'harness_stop_failed', 'cancel_ignored')),
  cancel_failed boolean NOT NULL DEFAULT false,
  cancel_failed_at timestamptz,
  cancel_failed_reason text,
  cancel_failed_source text CHECK (cancel_failed_source IS NULL OR cancel_failed_source IN ('harness_stop', 'cancel_ignored')),
  activity_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  sdk_run_status text CHECK (sdk_run_status IS NULL OR sdk_run_status IN ('running', 'finished', 'error', 'cancelled')),
  sdk_run_status_observed_at timestamptz,
  sdk_run_status_source text CHECK (sdk_run_status_source IS NULL OR sdk_run_status_source IN ('initial', 'onDidChangeStatus', 'wait')),
  failure_kind text,
  failure_diagnostic_code text,
  failure_diagnostic_message text,
  failure_diagnostic_at timestamptz,
  failure_diagnostic_payload jsonb,
  failure_diagnostic_raw_payload_ref_id bigint REFERENCES symphony.raw_payload_reference(raw_payload_ref_id),
  pending_approval_request_id text,
  pending_approval_requested_at timestamptz,
  provider_limit jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (updated_at >= started_at),
  CHECK (jsonb_typeof(runtime_model_params) = 'array'),
  CHECK (jsonb_typeof(runtime_setting_sources) = 'array'),
  CHECK (jsonb_typeof(cursor_model_params) = 'array'),
  CHECK (jsonb_typeof(cursor_setting_sources) = 'array')
);

COMMENT ON TABLE symphony.run_session IS
  'Symphony-owned run/session metadata and external agent-session correlation. External runtime harnesses and agent sessions remain authoritative for live execution.';

CREATE INDEX IF NOT EXISTS run_session_lookup_idx
  ON symphony.run_session (session_id, run_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_session_issue_status_idx
  ON symphony.run_session (issue_key, status, started_at DESC);
CREATE INDEX IF NOT EXISTS run_session_identifier_started_idx
  ON symphony.run_session (issue_identifier, started_at DESC);
CREATE INDEX IF NOT EXISTS run_session_workspace_idx
  ON symphony.run_session (workspace_key, started_at DESC);

CREATE TABLE IF NOT EXISTS symphony.run_activity_event (
  run_activity_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL,
  run_id text NOT NULL REFERENCES symphony.run_session(run_id) ON DELETE CASCADE,
  session_id text,
  run_session_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  sequence_source text NOT NULL CHECK (sequence_source IN ('harness', 'symphony')),
  event_at timestamptz NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('json_rpc', 'acp', 'symphony', 'unknown')),
  harness_id text NOT NULL,
  external_event_id text,
  actor text NOT NULL CHECK (
    actor IN ('orchestrator', 'harness', 'runtime', 'assistant', 'user', 'tool', 'operator', 'provider', 'system')
  ),
  channel text NOT NULL CHECK (channel IN ('lifecycle', 'message', 'tool', 'status', 'token', 'rate_limit', 'terminal')),
  kind text NOT NULL,
  text text,
  text_char_count integer NOT NULL DEFAULT 0 CHECK (text_char_count >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_schema text,
  payload_truncated boolean NOT NULL DEFAULT false,
  payload_byte_length bigint CHECK (payload_byte_length IS NULL OR payload_byte_length >= 0),
  raw_payload_ref_id bigint REFERENCES symphony.raw_payload_reference(raw_payload_ref_id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id),
  UNIQUE (run_session_id, sequence),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE symphony.run_activity_event IS
  'Normalized ordered run activity events keyed by stable event_id plus run-session sequence. Large raw harness payloads are referenced through raw_payload_ref_id instead of embedded.';
COMMENT ON COLUMN symphony.run_activity_event.run_session_id IS
  'Durable ordering and idempotency scope for the Symphony run attempt; raw session_id is correlation metadata only.';
COMMENT ON COLUMN symphony.run_activity_event.sequence_source IS
  'Whether sequence was preserved from the harness/protocol or assigned by Symphony during transactional append.';
COMMENT ON COLUMN symphony.run_activity_event.external_event_id IS
  'Optional upstream harness/runtime event id used with run_session_id for idempotent duplicate detection during replay/import.';
COMMENT ON COLUMN symphony.run_activity_event.run_activity_event_id IS
  'Monotonic append revision returned to reducers and realtime publishers after transactional persistence.';
COMMENT ON COLUMN symphony.run_activity_event.payload IS
  'Normalized, redacted, size-capped structured event payload suitable for projections and status APIs.';
COMMENT ON COLUMN symphony.run_activity_event.raw_payload_ref_id IS
  'Reference to oversized raw harness payload bytes when payload is truncated or unsuitable for inline projection JSON.';

CREATE INDEX IF NOT EXISTS run_activity_event_ordering_idx
  ON symphony.run_activity_event (run_session_id, sequence);
CREATE INDEX IF NOT EXISTS run_activity_event_run_ordering_idx
  ON symphony.run_activity_event (run_id, run_session_id, sequence);
CREATE INDEX IF NOT EXISTS run_activity_event_time_ordering_idx
  ON symphony.run_activity_event (run_session_id, event_at, sequence);
CREATE INDEX IF NOT EXISTS run_activity_event_kind_time_idx
  ON symphony.run_activity_event (kind, event_at DESC);
CREATE INDEX IF NOT EXISTS run_activity_event_channel_kind_time_idx
  ON symphony.run_activity_event (channel, kind, event_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS run_activity_event_external_event_unique_idx
  ON symphony.run_activity_event (run_session_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS symphony.chat_message (
  chat_message_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id text NOT NULL,
  thread_key text NOT NULL,
  issue_key text,
  issue_identifier text,
  run_id text REFERENCES symphony.run_session(run_id) ON DELETE SET NULL,
  session_id text,
  message_index integer NOT NULL CHECK (message_index >= 0),
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'agent', 'orchestrator', 'tool')),
  message_kind text NOT NULL DEFAULT 'message',
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
  body text NOT NULL DEFAULT '',
  body_preview text NOT NULL DEFAULT '',
  body_char_count integer NOT NULL DEFAULT 0 CHECK (body_char_count >= 0),
  body_truncated boolean NOT NULL DEFAULT false,
  event_sequence_start integer CHECK (event_sequence_start IS NULL OR event_sequence_start > 0),
  event_sequence_end integer CHECK (event_sequence_end IS NULL OR event_sequence_end > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_payload_ref_id bigint REFERENCES symphony.raw_payload_reference(raw_payload_ref_id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id),
  UNIQUE (thread_key, message_index),
  CHECK (event_sequence_end IS NULL OR event_sequence_start IS NOT NULL),
  CHECK (event_sequence_start IS NULL OR event_sequence_end IS NULL OR event_sequence_end >= event_sequence_start),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (updated_at >= created_at)
);

COMMENT ON TABLE symphony.chat_message IS
  'Symphony-owned normalized chat/orchestrator message stream used to reconstruct user-visible messages from ordered run activity event ranges.';
COMMENT ON COLUMN symphony.chat_message.raw_payload_ref_id IS
  'Reference to oversized raw message body/payload bytes when the inline body or payload is truncated.';

CREATE INDEX IF NOT EXISTS chat_message_ordering_idx
  ON symphony.chat_message (thread_key, message_index);
CREATE INDEX IF NOT EXISTS chat_message_issue_ordering_idx
  ON symphony.chat_message (issue_key, created_at, message_index);
CREATE INDEX IF NOT EXISTS chat_message_run_ordering_idx
  ON symphony.chat_message (run_id, message_index)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_message_event_range_idx
  ON symphony.chat_message (run_id, event_sequence_start, event_sequence_end)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS symphony.writeback_operation (
  idempotency_key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('transition', 'comment', 'issue_create', 'issue_relation')),
  issue_key text NOT NULL,
  external_issue_id text,
  issue_identifier text,
  run_id text,
  status text NOT NULL CHECK (status IN ('pending', 'in_flight', 'succeeded', 'skipped', 'retrying', 'dead_letter')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  result_status text,
  result_message text,
  result_evidence jsonb,
  payload jsonb NOT NULL,
  payload_sha256 text,
  raw_payload_ref_id bigint REFERENCES symphony.raw_payload_reference(raw_payload_ref_id),
  CHECK (updated_at >= created_at),
  CHECK (next_attempt_at >= created_at),
  CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE symphony.writeback_operation IS
  'Symphony-owned durable writeback outbox state. Linear/GitHub remain authoritative for the external write results recorded in result_* snapshot fields.';

CREATE INDEX IF NOT EXISTS writeback_operation_state_idx
  ON symphony.writeback_operation (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS writeback_operation_issue_idx
  ON symphony.writeback_operation (issue_key, created_at DESC);
CREATE INDEX IF NOT EXISTS writeback_operation_run_idx
  ON symphony.writeback_operation (run_id, created_at DESC)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS symphony.approval_request (
  request_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale', 'expired', 'cancelled')),
  issue_key text NOT NULL,
  external_issue_id text,
  issue_identifier text NOT NULL,
  run_id text NOT NULL,
  evidence_cursor text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  action jsonb NOT NULL,
  requested_at timestamptz NOT NULL,
  expires_at timestamptz,
  resolved_at timestamptz,
  resolved_by text CHECK (resolved_by IS NULL OR resolved_by IN ('operator', 'system')),
  decision text CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
  stale_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(action) = 'object'),
  CHECK (expires_at IS NULL OR expires_at >= requested_at),
  CHECK (resolved_at IS NULL OR resolved_at >= requested_at)
);

COMMENT ON TABLE symphony.approval_request IS
  'Symphony-owned operator approval gate records for publication actions. The external git/GitHub side effect occurs only after approved service-owned processing.';

CREATE INDEX IF NOT EXISTS approval_request_state_idx
  ON symphony.approval_request (status, expires_at, requested_at);
CREATE INDEX IF NOT EXISTS approval_request_issue_idx
  ON symphony.approval_request (issue_key, requested_at DESC);
CREATE INDEX IF NOT EXISTS approval_request_run_idx
  ON symphony.approval_request (run_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS symphony.external_sync_cursor (
  source_system text NOT NULL,
  cursor_key text NOT NULL,
  cursor_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  high_watermark text,
  external_snapshot_at timestamptz,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_error text,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, cursor_key),
  CHECK (jsonb_typeof(cursor_value) = 'object')
);

COMMENT ON TABLE symphony.external_sync_cursor IS
  'Symphony-owned polling/import cursors for external authorities such as Linear and GitHub. Cursors are not the source of truth for external records.';

CREATE INDEX IF NOT EXISTS external_sync_cursor_lease_idx
  ON symphony.external_sync_cursor (source_system, lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_sync_cursor_updated_idx
  ON symphony.external_sync_cursor (source_system, updated_at DESC);

CREATE TABLE IF NOT EXISTS symphony.projection_revision (
  projection_revision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  projection_name text NOT NULL CHECK (
    projection_name IN (
      'dashboard_projection',
      'issue_board_projection',
      'sidebar_projection',
      'history_projection',
      'transcript_projection',
      'orchestrator_chat_projection'
    )
  ),
  scope_kind text NOT NULL DEFAULT 'global',
  scope_key text NOT NULL DEFAULT 'global',
  revision bigint NOT NULL CHECK (revision > 0),
  source_revisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_cursors jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_sha256 text,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (projection_name, scope_kind, scope_key, revision),
  CHECK (jsonb_typeof(source_revisions) = 'array'),
  CHECK (jsonb_typeof(source_cursors) = 'object')
);

COMMENT ON TABLE symphony.projection_revision IS
  'Durable monotonic projection revision metadata for frontend read models. Rows capture the Symphony and external-source revisions used to derive each projection payload.';

CREATE INDEX IF NOT EXISTS projection_revision_reads_idx
  ON symphony.projection_revision (projection_name, scope_kind, scope_key, revision DESC, generated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS projection_revision_current_unique_idx
  ON symphony.projection_revision (projection_name, scope_kind, scope_key)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS symphony.dashboard_projection (
  projection_revision_id bigint PRIMARY KEY REFERENCES symphony.projection_revision(projection_revision_id) ON DELETE CASCADE,
  scope_key text NOT NULL DEFAULT 'global',
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  payload_sha256 text,
  raw_payload_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (jsonb_typeof(raw_payload_refs) = 'array')
);

COMMENT ON TABLE symphony.dashboard_projection IS
  'Durable dashboard read-model payload derived from Symphony-owned normalized state and external snapshots.';

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_projection_scope_revision_idx
  ON symphony.dashboard_projection (scope_key, revision);
CREATE INDEX IF NOT EXISTS dashboard_projection_revision_reads_idx
  ON symphony.dashboard_projection (scope_key, revision DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS symphony.issue_board_projection (
  projection_revision_id bigint PRIMARY KEY REFERENCES symphony.projection_revision(projection_revision_id) ON DELETE CASCADE,
  scope_key text NOT NULL DEFAULT 'default-board',
  revision bigint NOT NULL CHECK (revision > 0),
  fetched_states jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL,
  payload_sha256 text,
  raw_payload_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (jsonb_typeof(fetched_states) = 'array'),
  CHECK (jsonb_typeof(raw_payload_refs) = 'array')
);

COMMENT ON TABLE symphony.issue_board_projection IS
  'Durable issue board projection. Tracker fields are Linear snapshots; Symphony-only fields come from owned run/lifecycle/writeback state.';

CREATE UNIQUE INDEX IF NOT EXISTS issue_board_projection_scope_revision_idx
  ON symphony.issue_board_projection (scope_key, revision);
CREATE INDEX IF NOT EXISTS issue_board_projection_revision_reads_idx
  ON symphony.issue_board_projection (scope_key, revision DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS symphony.sidebar_projection (
  projection_revision_id bigint PRIMARY KEY REFERENCES symphony.projection_revision(projection_revision_id) ON DELETE CASCADE,
  scope_key text NOT NULL DEFAULT 'global',
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  payload_sha256 text,
  raw_payload_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (jsonb_typeof(raw_payload_refs) = 'array')
);

COMMENT ON TABLE symphony.sidebar_projection IS
  'Durable sidebar read model for provider gates, running agents, review issues, activity, sessions, chat, and totals.';

CREATE UNIQUE INDEX IF NOT EXISTS sidebar_projection_scope_revision_idx
  ON symphony.sidebar_projection (scope_key, revision);
CREATE INDEX IF NOT EXISTS sidebar_projection_revision_reads_idx
  ON symphony.sidebar_projection (scope_key, revision DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS symphony.history_projection (
  projection_revision_id bigint PRIMARY KEY REFERENCES symphony.projection_revision(projection_revision_id) ON DELETE CASCADE,
  scope_key text NOT NULL DEFAULT 'global',
  issue_key text,
  run_id text,
  session_id text,
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  payload_sha256 text,
  raw_payload_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (jsonb_typeof(raw_payload_refs) = 'array')
);

COMMENT ON TABLE symphony.history_projection IS
  'Durable run/session history projection built from normalized run metadata and transcript counts, not live external agent state.';

CREATE UNIQUE INDEX IF NOT EXISTS history_projection_scope_revision_idx
  ON symphony.history_projection (scope_key, revision);
CREATE INDEX IF NOT EXISTS history_projection_revision_reads_idx
  ON symphony.history_projection (scope_key, revision DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS history_projection_run_lookup_idx
  ON symphony.history_projection (run_id, session_id, revision DESC)
  WHERE run_id IS NOT NULL OR session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS symphony.transcript_projection (
  projection_revision_id bigint PRIMARY KEY REFERENCES symphony.projection_revision(projection_revision_id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  run_id text NOT NULL,
  session_id text,
  revision bigint NOT NULL CHECK (revision > 0),
  offset_start integer NOT NULL DEFAULT 0 CHECK (offset_start >= 0),
  offset_limit integer NOT NULL DEFAULT 100 CHECK (offset_limit > 0),
  next_offset integer CHECK (next_offset IS NULL OR next_offset >= 0),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  payload jsonb NOT NULL,
  payload_sha256 text,
  raw_payload_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (jsonb_typeof(raw_payload_refs) = 'array')
);

COMMENT ON TABLE symphony.transcript_projection IS
  'Durable web transcript projection containing sanitized/capped transcript messages. Raw tool output remains in raw_payload_reference when retained.';

CREATE UNIQUE INDEX IF NOT EXISTS transcript_projection_scope_revision_idx
  ON symphony.transcript_projection (scope_key, revision);
CREATE INDEX IF NOT EXISTS transcript_projection_revision_reads_idx
  ON symphony.transcript_projection (run_id, revision DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS transcript_projection_session_reads_idx
  ON symphony.transcript_projection (session_id, revision DESC)
  WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS symphony.orchestrator_chat_projection (
  projection_revision_id bigint PRIMARY KEY REFERENCES symphony.projection_revision(projection_revision_id) ON DELETE CASCADE,
  scope_key text NOT NULL DEFAULT 'global',
  issue_key text,
  run_id text,
  conversation_key text NOT NULL DEFAULT 'default',
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  payload_sha256 text,
  raw_payload_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (jsonb_typeof(raw_payload_refs) = 'array')
);

COMMENT ON TABLE symphony.orchestrator_chat_projection IS
  'Durable orchestrator chat read model derived from symphony.chat_message and run/activity correlations.';

CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_chat_projection_scope_revision_idx
  ON symphony.orchestrator_chat_projection (scope_key, conversation_key, revision);
CREATE INDEX IF NOT EXISTS orchestrator_chat_projection_revision_reads_idx
  ON symphony.orchestrator_chat_projection (scope_key, conversation_key, revision DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS orchestrator_chat_projection_issue_idx
  ON symphony.orchestrator_chat_projection (issue_key, revision DESC)
  WHERE issue_key IS NOT NULL;

COMMIT;
