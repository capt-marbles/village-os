PRAGMA foreign_keys = ON;

CREATE TABLE pairing_challenges (
  principal_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_display_name TEXT NOT NULL,
  public_key_json TEXT NOT NULL CHECK (json_valid(public_key_json)),
  protection TEXT NOT NULL CHECK (protection IN ('HARDWARE_NON_EXPORTABLE', 'OS_PROTECTED_FALLBACK')),
  secret_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  attempts_remaining INTEGER NOT NULL CHECK (attempts_remaining BETWEEN 0 AND 10),
  state TEXT NOT NULL CHECK (state IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'EXPIRED', 'REJECTED', 'CONSUMED')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  consumed_at TEXT,
  PRIMARY KEY (principal_id, pairing_id),
  UNIQUE (pairing_id),
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE CASCADE
);

CREATE TABLE browser_session_event_projections (
  principal_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  projected_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, browser_session_id, sequence),
  FOREIGN KEY (principal_id, browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE CASCADE
);

CREATE TABLE protocol_replay_windows (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  highest_command_sequence INTEGER NOT NULL DEFAULT 0 CHECK (highest_command_sequence >= 0),
  highest_result_sequence INTEGER NOT NULL DEFAULT 0 CHECK (highest_result_sequence >= 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, device_id, browser_session_id),
  FOREIGN KEY (principal_id, device_id)
    REFERENCES devices(principal_id, device_id) ON DELETE CASCADE
);

CREATE INDEX pairing_challenges_by_expiry
  ON pairing_challenges(state, expires_at);
CREATE INDEX browser_session_events_by_owner_time
  ON browser_session_event_projections(principal_id, browser_session_id, sequence);
