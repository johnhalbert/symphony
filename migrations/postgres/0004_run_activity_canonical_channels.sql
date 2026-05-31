-- Symphony Postgres schema migration 0004: canonical run activity channel names.
--
-- 0002_symphony_owned_state.sql was published with adapter-facing `message`
-- and `status` channel names in the run_activity_event check constraint. Runtime
-- event mapping now normalizes those aliases to the frontend-facing `chat` and
-- `diagnostic` channels before persistence, so upgrade the persisted schema
-- without changing the published 0002 checksum.

ALTER TABLE symphony.run_activity_event
  DROP CONSTRAINT IF EXISTS run_activity_event_channel_check;

UPDATE symphony.run_activity_event
SET channel = CASE channel
  WHEN 'message' THEN 'chat'
  WHEN 'status' THEN 'diagnostic'
  ELSE channel
END
WHERE channel IN ('message', 'status');

ALTER TABLE symphony.run_activity_event
  ADD CONSTRAINT run_activity_event_channel_check
  CHECK (channel IN ('lifecycle', 'chat', 'tool', 'diagnostic', 'token', 'rate_limit', 'terminal'));
