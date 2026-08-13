PRAGMA foreign_keys = ON;

ALTER TABLE authenticated_quota_usage
  ADD COLUMN replays INTEGER NOT NULL DEFAULT 0 CHECK (replays >= 0);

CREATE TABLE authenticated_principal_quota_usage (
  principal_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  connections INTEGER NOT NULL DEFAULT 0 CHECK (connections >= 0),
  commands INTEGER NOT NULL DEFAULT 0 CHECK (commands >= 0),
  replays INTEGER NOT NULL DEFAULT 0 CHECK (replays >= 0),
  notifications INTEGER NOT NULL DEFAULT 0 CHECK (notifications >= 0),
  retained_records INTEGER NOT NULL DEFAULT 0 CHECK (retained_records >= 0),
  PRIMARY KEY (principal_id, window_started_at),
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE CASCADE
);

CREATE TABLE action_receipts (
  principal_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'POSTCONDITION_SATISFIED', 'POSTCONDITION_NOT_SATISFIED', 'OUTCOME_UNKNOWN'
  )),
  predicate_ids_json TEXT NOT NULL CHECK (json_valid(predicate_ids_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, browser_session_id, receipt_id),
  FOREIGN KEY (principal_id, browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, job_id)
    REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, browser_session_id, action_id)
    REFERENCES browser_actions(principal_id, browser_session_id, action_id) ON DELETE CASCADE
);

CREATE TABLE principal_deletion_plans (
  principal_id TEXT NOT NULL,
  deletion_request_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'COMPLETED', 'VERIFICATION_FAILED')),
  completed_at TEXT,
  PRIMARY KEY (principal_id, deletion_request_id)
);

CREATE INDEX action_receipts_by_principal_job
  ON action_receipts(principal_id, job_id, recorded_at);
CREATE INDEX principal_deletion_plans_by_status
  ON principal_deletion_plans(status, requested_at);
