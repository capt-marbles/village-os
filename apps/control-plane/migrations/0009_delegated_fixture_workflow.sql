PRAGMA foreign_keys = ON;

-- Rollout/rollback compatibility: legacy authentication rows keep these NULL.
ALTER TABLE jobs ADD COLUMN objective_kind TEXT;
ALTER TABLE jobs ADD COLUMN objective_version INTEGER;
ALTER TABLE jobs ADD COLUMN workflow_schema_version INTEGER;

ALTER TABLE browser_actions ADD COLUMN job_id TEXT;
ALTER TABLE browser_actions ADD COLUMN job_revision INTEGER;
ALTER TABLE browser_actions ADD COLUMN objective_kind TEXT;
ALTER TABLE browser_actions ADD COLUMN objective_version INTEGER;
ALTER TABLE browser_actions ADD COLUMN logical_step TEXT;
ALTER TABLE browser_actions ADD COLUMN effect_id TEXT;

ALTER TABLE checkpoints ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE checkpoints ADD COLUMN checkpoint_json TEXT CHECK (
  checkpoint_json IS NULL OR json_valid(checkpoint_json)
);

ALTER TABLE action_receipts ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE action_receipts ADD COLUMN device_id TEXT;
ALTER TABLE action_receipts ADD COLUMN step_id TEXT;
ALTER TABLE action_receipts ADD COLUMN objective_kind TEXT;
ALTER TABLE action_receipts ADD COLUMN objective_version INTEGER;
ALTER TABLE action_receipts ADD COLUMN job_revision INTEGER;
ALTER TABLE action_receipts ADD COLUMN logical_step TEXT;
ALTER TABLE action_receipts ADD COLUMN effect_id TEXT;
ALTER TABLE action_receipts ADD COLUMN lease_epoch INTEGER;

CREATE TABLE workflow_effect_projections (
  principal_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_revision INTEGER NOT NULL CHECK (job_revision > 0),
  workflow_kind TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  logical_step TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  canonical_action_id TEXT,
  action_phase TEXT NOT NULL,
  receipt_id TEXT,
  checkpoint_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, browser_session_id, logical_step),
  UNIQUE (principal_id, browser_session_id, effect_id),
  FOREIGN KEY (principal_id, browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, job_id)
    REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE
);

CREATE TABLE workflow_cancellations (
  principal_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  cancellation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  expected_job_revision INTEGER NOT NULL CHECK (expected_job_revision > 0),
  resulting_job_revision INTEGER NOT NULL CHECK (resulting_job_revision > 0),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, browser_session_id, cancellation_id),
  FOREIGN KEY (principal_id, browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, job_id)
    REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE
);

CREATE INDEX workflow_effects_by_retention
  ON workflow_effect_projections(principal_id, updated_at);
CREATE INDEX workflow_cancellations_by_retention
  ON workflow_cancellations(principal_id, accepted_at);
