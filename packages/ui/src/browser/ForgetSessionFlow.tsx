import {
  browserActionLabel,
  BrowserErasure,
  BrowserUiAction,
} from "./browser-ui-state-matrix.js";

export function ForgetSessionFlow({
  state,
  onAction,
}: {
  state: BrowserErasure;
  onAction?: (action: BrowserUiAction) => void;
}) {
  if (state === "IDLE" || state === "COMPLETE") return null;
  const failed = state === "FAILED";
  return (
    <section aria-labelledby="forget-title" style={{ padding: "1rem" }}>
      <h2 id="forget-title">
        {failed ? "Session removal was incomplete" : "Forget local session"}
      </h2>
      <p>
        {failed
          ? "Retry to finish clearing this profile. Other profiles are untouched."
          : "This is separate from canceling work and requires step-up authentication plus confirmation."}
      </p>
      {failed ? (
        <button type="button" onClick={() => onAction?.("RETRY_ERASURE")}>
          {browserActionLabel.RETRY_ERASURE}
        </button>
      ) : null}
    </section>
  );
}
