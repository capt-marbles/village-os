import {
  browserActionLabel,
  type BrowserUiAction,
} from "./browser-ui-state-matrix.js";

export function VerificationPrompt({
  onAction,
}: {
  onAction?: (action: BrowserUiAction) => void;
}) {
  return (
    <section aria-labelledby="verification-title" style={{ padding: "1rem" }}>
      <h2 id="verification-title">Is this the expected account?</h2>
      <p>
        Village cannot establish the account safely. Your confirmation will be
        recorded as owner-confirmed, not automatic verification.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: ".6rem" }}>
        <button type="button" onClick={() => onAction?.("CONFIRM_ACCOUNT")}>
          {browserActionLabel.CONFIRM_ACCOUNT}
        </button>
        <button type="button" onClick={() => onAction?.("REJECT_ACCOUNT")}>
          {browserActionLabel.REJECT_ACCOUNT}
        </button>
      </div>
    </section>
  );
}
