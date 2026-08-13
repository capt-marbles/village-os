CREATE INDEX job_events_by_retention
  ON job_events(principal_id, occurred_at);
CREATE INDEX checkpoints_by_retention
  ON checkpoints(principal_id, created_at);
CREATE INDEX browser_session_projections_by_retention
  ON browser_session_event_projections(principal_id, occurred_at);
CREATE INDEX action_receipts_by_retention
  ON action_receipts(principal_id, recorded_at);
