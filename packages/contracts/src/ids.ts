import { z } from "zod";

function villageId(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
}

export const principalIdSchema = villageId("prn");
export const deviceIdSchema = villageId("dev");
export const jobIdSchema = villageId("job");
export const browserSessionIdSchema = villageId("brs");
export const actionIdSchema = villageId("act");
export const eventIdSchema = villageId("evt");
export const hostIdSchema = villageId("hst");
export const humanGateIdSchema = villageId("hgt");
export const secretFillAuthorizationIdSchema = villageId("sfa");
export const documentIdSchema = villageId("doc");
export const frameIdSchema = villageId("frm");
export const nodeIdSchema = villageId("nod");
export const operationAuthorizationIdSchema = villageId("opa");
export const stepUpAuthorizationIdSchema = villageId("stp");
export const pairingIdSchema = villageId("par");
export const checkpointIdSchema = villageId("chk");
export const browserStepIdSchema = villageId("bsp");
export const receiptIdSchema = villageId("rcp");
export const effectIdSchema = villageId("efx");

export const setupWorkflowKindSchema = z.literal(
  "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
);
export const setupWorkflowVersionSchema = z.literal(1);
export const setupObjectiveSchema = z.strictObject({
  kind: setupWorkflowKindSchema,
  version: setupWorkflowVersionSchema,
});
export const setupLogicalStepSchema = z.enum([
  "SET_DISPLAY_NAME",
  "SELECT_ROLE",
  "SET_PREFERRED_FOCUS",
  "FINALIZE_SETUP",
]);

export const instantSchema = z.iso.datetime({ offset: true });
