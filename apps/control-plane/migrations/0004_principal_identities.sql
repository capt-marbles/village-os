PRAGMA foreign_keys = ON;

CREATE TABLE principal_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE CASCADE
);

CREATE INDEX principal_identities_by_principal
  ON principal_identities(principal_id);
