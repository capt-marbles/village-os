PRAGMA foreign_keys = ON;

CREATE TABLE browser_sessions (
  principal_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  site TEXT NOT NULL CHECK (site IN ('OWNED_FIXTURE', 'LINKEDIN')),
  controller TEXT NOT NULL CHECK (controller IN ('NONE', 'AGENT', 'USER')),
  connection_state TEXT NOT NULL CHECK (connection_state IN ('ONLINE', 'OFFLINE', 'ABSENT')),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
  lease_expires_at TEXT,
  last_accepted_sequence INTEGER NOT NULL DEFAULT 0,
  automation_blocked INTEGER NOT NULL CHECK (automation_blocked IN (0, 1)),
  takeover_state TEXT NOT NULL CHECK (takeover_state IN ('NONE', 'QUIESCING', 'OFFLINE_MARKED', 'RECONCILING')),
  profile_state TEXT NOT NULL CHECK (profile_state IN ('PRESENT', 'FORGETTING', 'ABSENT', 'ERASURE_FAILED')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, browser_session_id),
  FOREIGN KEY (principal_id, job_id) REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, device_id) REFERENCES devices(principal_id, device_id) ON DELETE RESTRICT
);

CREATE TABLE browser_actions (
  principal_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  command_sequence INTEGER NOT NULL CHECK (command_sequence > 0),
  phase TEXT NOT NULL CHECK (phase IN ('ACCEPTED', 'DISPATCHED', 'EFFECT_OBSERVED', 'RECEIPTED', 'RECONCILIATION_REQUIRED')),
  mutation_class TEXT NOT NULL CHECK (mutation_class IN ('READ_ONLY', 'IDEMPOTENT', 'NON_IDEMPOTENT')),
  postcondition TEXT NOT NULL CHECK (postcondition IN ('UNOBSERVED', 'SATISFIED', 'NOT_SATISFIED', 'UNKNOWN')),
  accepted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, browser_session_id, action_id),
  UNIQUE (principal_id, browser_session_id, command_sequence),
  FOREIGN KEY (principal_id, browser_session_id) REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE CASCADE
);

CREATE TABLE human_gates (
  principal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  human_gate_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'RESOLVED', 'CANCELED')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (principal_id, job_id, human_gate_id),
  FOREIGN KEY (principal_id, job_id) REFERENCES jobs(principal_id, job_id) ON DELETE CASCADE
);

CREATE TABLE projection_outbox (
  principal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  projection_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  projected_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, job_id, event_sequence, projection_type),
  FOREIGN KEY (principal_id, job_id, event_sequence) REFERENCES job_events(principal_id, job_id, sequence) ON DELETE CASCADE
);

CREATE TABLE authenticated_quota_usage (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  connections INTEGER NOT NULL DEFAULT 0 CHECK (connections >= 0),
  commands INTEGER NOT NULL DEFAULT 0 CHECK (commands >= 0),
  notifications INTEGER NOT NULL DEFAULT 0 CHECK (notifications >= 0),
  retained_events INTEGER NOT NULL DEFAULT 0 CHECK (retained_events >= 0),
  PRIMARY KEY (principal_id, device_id, window_started_at),
  FOREIGN KEY (principal_id, device_id) REFERENCES devices(principal_id, device_id) ON DELETE CASCADE
);
