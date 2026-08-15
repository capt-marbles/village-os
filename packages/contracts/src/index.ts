import { z } from "zod";

export const productIdentity = Object.freeze({
  name: "Village",
  protocol: "village",
  protocolVersion: 1,
});

export const healthResponseSchema = z.strictObject({
  service: z.literal("village-control-plane"),
  deployment: z.string().min(1),
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./commands.js";
export * from "./actions.js";
export * from "./automation-sync.js";
export * from "./browser.js";
export * from "./ids.js";
export * from "./events.js";
export * from "./hosts.js";
export * from "./jobs.js";
export * from "./model-provider.js";
export * from "./redaction.js";
export * from "./rituals.js";
export * from "./secrets.js";
export * from "./signatures.js";
export * from "./workflow-operations.js";
