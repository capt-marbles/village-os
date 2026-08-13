import { humanGateReasonSchema } from "@village/contracts";

export function classifyOwnedFixtureChallenge(input: { kind: string }) {
  const parsed = humanGateReasonSchema.safeParse(input.kind);
  const reason = parsed.success ? parsed.data : "UNKNOWN_CHALLENGE";
  return {
    reason,
    resolver: "OWNER_ONLY" as const,
    automationAllowed: false as const,
  };
}
