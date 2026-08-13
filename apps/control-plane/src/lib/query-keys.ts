export const villageQueryKeys = {
  jobs: (principalId: string) => ["jobs", principalId] as const,
  job: (principalId: string, jobId: string) =>
    ["jobs", principalId, jobId] as const,
  browserSession: (principalId: string, browserSessionId: string) =>
    ["browser-session", principalId, browserSessionId] as const,
  browserEvents: (
    principalId: string,
    browserSessionId: string,
    cursor: number,
  ) => ["browser-events", principalId, browserSessionId, cursor] as const,
};
