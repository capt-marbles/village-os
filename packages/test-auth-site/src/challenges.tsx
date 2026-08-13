const typedChallenges = new Set([
  "CREDENTIAL",
  "CAPTCHA",
  "PASSKEY",
  "TWO_FACTOR",
  "PASSWORD_RESET",
  "FEDERATED_IDENTITY",
  "TERMS_OR_CONSENT",
  "SECURITY_WARNING",
]);

export function classifyOwnedFixtureChallenge(input: { kind: string }) {
  const reason = typedChallenges.has(input.kind)
    ? (input.kind as
        | "CREDENTIAL"
        | "CAPTCHA"
        | "PASSKEY"
        | "TWO_FACTOR"
        | "PASSWORD_RESET"
        | "FEDERATED_IDENTITY"
        | "TERMS_OR_CONSENT"
        | "SECURITY_WARNING")
    : "UNKNOWN_CHALLENGE";
  return {
    reason,
    resolver: "OWNER_ONLY" as const,
    automationAllowed: false as const,
  };
}
