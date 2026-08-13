import type { BrowserUiModel } from "./browser-ui-state-matrix.js";

export function BrowserStatusCard({ model }: { model: BrowserUiModel }) {
  return (
    <section
      aria-live="polite"
      aria-atomic="true"
      style={{ padding: "1rem", borderBottom: "1px solid #29322b" }}
    >
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>{model.label}</h2>
      <p style={{ margin: ".45rem 0 0", color: "#b8c2b8", lineHeight: 1.5 }}>
        {model.explanation}
      </p>
    </section>
  );
}
