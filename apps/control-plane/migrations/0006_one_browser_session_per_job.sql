CREATE UNIQUE INDEX one_browser_session_per_job
  ON browser_sessions(principal_id, job_id);
