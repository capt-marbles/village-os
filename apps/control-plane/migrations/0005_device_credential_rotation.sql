ALTER TABLE devices ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN rotated_at TEXT;
