PRAGMA foreign_keys = ON;

CREATE TABLE workflow_last_effect_actor (
  principal_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  workflow_kind TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  logical_step TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('AGENT', 'OWNER')),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, browser_session_id),
  FOREIGN KEY (principal_id, browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, job_id)
    REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE
);

CREATE INDEX workflow_last_effect_actor_by_retention
  ON workflow_last_effect_actor(principal_id, occurred_at);
