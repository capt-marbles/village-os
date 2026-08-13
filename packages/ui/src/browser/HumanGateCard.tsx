import type { HumanGateReason } from "./browser-ui-state-matrix.js";

const copy: Record<HumanGateReason, string> = {
  CREDENTIAL: "A credential is needed",
  TWO_FACTOR: "Two-factor authentication needs you",
  CAPTCHA: "A CAPTCHA needs you",
  PASSKEY: "A passkey prompt needs you",
  PASSWORD_RESET: "Password reset needs you",
  FEDERATED_IDENTITY: "Identity-provider sign-in needs you",
  TERMS_OR_CONSENT: "Terms or consent need your review",
  SECURITY_WARNING: "A security warning needs your review",
  UNKNOWN_CHALLENGE: "An unfamiliar sign-in step needs you",
};

export function HumanGateCard({ reason }: { reason: HumanGateReason }) {
  return (
    <section
      aria-label="Human action required"
      style={{
        margin: ".8rem",
        border: "1px solid #8a6d2f",
        borderRadius: 14,
        padding: ".9rem",
        background: "#2a2416",
      }}
    >
      <strong>{copy[reason]}</strong>
      <p style={{ margin: ".35rem 0 0", color: "#d9cfb7" }}>
        Village will not solve or bypass this step. Continue in the visible
        browser when control is yours.
      </p>
    </section>
  );
}
