PRAGMA foreign_keys = ON;

CREATE TABLE continuity_recipient_keys (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  site TEXT NOT NULL CHECK (site = 'OWNED_FIXTURE'),
  encryption_public_key TEXT NOT NULL CHECK (json_valid(encryption_public_key)),
  device_signing_public_key TEXT NOT NULL CHECK (json_valid(device_signing_public_key)),
  last_accepted_sequence INTEGER NOT NULL CHECK (last_accepted_sequence > 0),
  enrolled_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, device_id, browser_session_id, site),
  FOREIGN KEY (principal_id, device_id)
    REFERENCES devices(principal_id, device_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE CASCADE
);
