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
