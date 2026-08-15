PRAGMA foreign_keys = ON;

CREATE TABLE continuity_grants (
  principal_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  destination_device_id TEXT NOT NULL,
  source_browser_session_id TEXT NOT NULL,
  destination_browser_session_id TEXT NOT NULL,
  site TEXT NOT NULL CHECK (site = 'OWNED_FIXTURE'),
  destination_encryption_public_key TEXT CHECK (
    destination_encryption_public_key IS NULL OR
    json_valid(destination_encryption_public_key)
  ),
  source_signing_public_key TEXT CHECK (
    source_signing_public_key IS NULL OR json_valid(source_signing_public_key)
  ),
  destination_signing_public_key TEXT CHECK (
    destination_signing_public_key IS NULL OR
    json_valid(destination_signing_public_key)
  ),
  state TEXT NOT NULL CHECK (
    state IN ('PENDING', 'ACTIVE', 'REVOKED', 'DELETING', 'DELETED', 'EXPIRED')
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  deleted_at TEXT,
  PRIMARY KEY (principal_id, grant_id),
  FOREIGN KEY (principal_id, source_device_id)
    REFERENCES devices(principal_id, device_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, destination_device_id)
    REFERENCES devices(principal_id, device_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, source_browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, destination_browser_session_id)
    REFERENCES browser_sessions(principal_id, browser_session_id) ON DELETE RESTRICT
);

CREATE INDEX continuity_grants_by_source_device
  ON continuity_grants(principal_id, source_device_id, state);
CREATE INDEX continuity_grants_by_destination_device
  ON continuity_grants(principal_id, destination_device_id, state);
CREATE INDEX continuity_grants_by_expiry
  ON continuity_grants(state, expires_at);
