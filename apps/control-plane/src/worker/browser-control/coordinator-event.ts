export type CoordinatorEvent = {
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
};
