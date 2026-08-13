export type CloudRecordClass =
  "PROJECTIONS" | "EVENTS" | "CHECKPOINTS" | "RECEIPTS";

export type RecordRetentionPolicy = {
  scope: "PRINCIPAL";
  encryptionAtRest: "CLOUDFLARE_MANAGED";
  retentionDays: number;
  export: "AVAILABLE";
  deletion: "CASCADE_ON_PRINCIPAL_DELETE";
  backup: "EXPIRES_WITH_BACKUP_RETENTION";
  verification: "TOMBSTONE_AND_ABSENCE_CHECK";
};

const defaultRecordPolicy: RecordRetentionPolicy = {
  scope: "PRINCIPAL",
  encryptionAtRest: "CLOUDFLARE_MANAGED",
  retentionDays: 30,
  export: "AVAILABLE",
  deletion: "CASCADE_ON_PRINCIPAL_DELETE",
  backup: "EXPIRES_WITH_BACKUP_RETENTION",
  verification: "TOMBSTONE_AND_ABSENCE_CHECK",
};

/** Declarative lifecycle contract for every cloud record exposed to an owner. */
export const recordRetentionPolicies: Readonly<
  Record<CloudRecordClass, RecordRetentionPolicy>
> = {
  PROJECTIONS: defaultRecordPolicy,
  EVENTS: defaultRecordPolicy,
  CHECKPOINTS: defaultRecordPolicy,
  RECEIPTS: defaultRecordPolicy,
};
