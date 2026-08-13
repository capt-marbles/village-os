PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  retention_policy TEXT NOT NULL DEFAULT 'OWNER_DEFAULT'
);

CREATE TABLE devices (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  credential_status TEXT NOT NULL CHECK (credential_status IN ('ACTIVE', 'REVOKED')),
  protocol_version INTEGER NOT NULL,
  last_accepted_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (principal_id, device_id),
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE CASCADE
);

CREATE TABLE jobs (
  principal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  browser_session_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'QUEUED', 'WAITING_FOR_BROWSER', 'RUNNING_AGENT', 'WAITING_FOR_SECRET',
    'WAITING_FOR_USER', 'RUNNING_USER', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'CANCELED'
  )),
  version INTEGER NOT NULL CHECK (version > 0),
  last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence > 0),
  active_human_gate_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, job_id),
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE CASCADE
);

CREATE TABLE job_events (
  principal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, job_id, sequence),
  UNIQUE (event_id),
  FOREIGN KEY (principal_id, job_id) REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE
);

CREATE TABLE checkpoints (
  principal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  job_version INTEGER NOT NULL CHECK (job_version > 0),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, job_id, checkpoint_id),
  FOREIGN KEY (principal_id, job_id) REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE
);

CREATE INDEX job_events_by_event_id ON job_events(event_id);
CREATE INDEX jobs_by_principal_state ON jobs(principal_id, state, updated_at);
