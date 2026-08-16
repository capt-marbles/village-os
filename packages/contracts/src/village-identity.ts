import { z } from "zod";
import { principalIdSchema } from "./ids.js";

export const villageIdentitySessionSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    authenticated: z.literal(true),
    principalId: principalIdSchema,
    provider: z.literal("CLOUDFLARE_ACCESS"),
    email: z.string().email().max(320),
    signOutPath: z.literal("/cdn-cgi/access/logout"),
  }),
  z.strictObject({
    authenticated: z.literal(true),
    principalId: principalIdSchema,
    provider: z.literal("DEVELOPMENT"),
  }),
]);

export type VillageIdentitySession = z.infer<
  typeof villageIdentitySessionSchema
>;
