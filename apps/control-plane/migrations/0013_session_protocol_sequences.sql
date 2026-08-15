ALTER TABLE browser_sessions
ADD COLUMN last_automation_sync_sequence INTEGER NOT NULL DEFAULT 0;

ALTER TABLE browser_sessions
ADD COLUMN last_workflow_operation_sequence INTEGER NOT NULL DEFAULT 0;
