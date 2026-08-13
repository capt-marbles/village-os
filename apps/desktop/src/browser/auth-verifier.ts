import {
  verificationResultSchema,
  type VerificationResult,
} from "@village/contracts";
import type { BrowserSite } from "./session-policy.js";
import { classifyLinkedInRoute } from "./sites/linkedin.js";

export interface AuthenticationVerificationInput {
  site: BrowserSite;
  url: string;
  predicateVersion: string;
  debuggerAttached: boolean;
  expectedAccountAmbiguous?: boolean;
  ownerDecision?: "CONFIRM" | "REJECT";
  fixturePredicate?: "AUTHENTICATED" | "NOT_AUTHENTICATED" | "UNKNOWN";
}

export function verifyAuthentication(
  input: AuthenticationVerificationInput,
): VerificationResult {
  if (input.site === "LINKEDIN" && input.debuggerAttached) {
    throw new Error("LINKEDIN_DEBUGGER_ATTACHMENT_DENIED");
  }
  if (input.ownerDecision !== undefined && !input.expectedAccountAmbiguous) {
    throw new Error("OWNER_CONFIRMATION_NOT_APPLICABLE");
  }
  const linkedInRoute =
    input.site === "LINKEDIN" ? classifyLinkedInRoute(input.url) : undefined;
  if (input.ownerDecision === "CONFIRM" && linkedInRoute === "AUTHENTICATED") {
    return verificationResultSchema.parse({
      status: "confirmed_by_user",
      predicateVersion: input.predicateVersion,
    });
  }
  if (input.ownerDecision === "REJECT") {
    return verificationResultSchema.parse({
      status: "not_authenticated",
      predicateVersion: input.predicateVersion,
    });
  }

  let status: VerificationResult["status"];
  if (input.site === "LINKEDIN") {
    status = linkedInRoute === "SIGN_IN" ? "not_authenticated" : "unknown";
  } else {
    status =
      input.fixturePredicate === "AUTHENTICATED"
        ? "authenticated"
        : input.fixturePredicate === "NOT_AUTHENTICATED"
          ? "not_authenticated"
          : "unknown";
  }
  return verificationResultSchema.parse({
    status,
    predicateVersion: input.predicateVersion,
  });
}
