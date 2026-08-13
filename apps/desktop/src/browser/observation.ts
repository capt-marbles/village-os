import type { BrowserSite } from "./session-policy.js";
import { originForSite } from "./session-policy.js";

export interface LocalObservationInput {
  site: BrowserSite;
  url: string;
  authState: "AUTHENTICATED" | "NOT_AUTHENTICATED" | "UNKNOWN";
  humanGate: boolean;
}

export interface SafeBrowserObservation {
  site: BrowserSite;
  origin: string;
  predicates: readonly ["pred_auth_state_v1"];
  authState: LocalObservationInput["authState"];
  humanGate: boolean;
}

export function createSafeObservation(
  input: LocalObservationInput,
): SafeBrowserObservation {
  const parsed = new URL(input.url);
  const expectedOrigin = originForSite(input.site);
  if (parsed.origin !== expectedOrigin) {
    throw new Error("OBSERVATION_ORIGIN_DENIED");
  }
  return {
    site: input.site,
    origin: expectedOrigin,
    predicates: ["pred_auth_state_v1"],
    authState: input.authState,
    humanGate: input.humanGate,
  };
}
