ALTER TABLE browser_sessions
ADD COLUMN last_continuity_activation_sequence INTEGER NOT NULL DEFAULT 0;
