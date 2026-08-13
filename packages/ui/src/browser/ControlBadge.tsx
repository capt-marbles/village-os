import type { BrowserUiModel } from "./browser-ui-state-matrix.js";

const colors: Record<BrowserUiModel["tone"], string> = {
  NEUTRAL: "#a8b0a8",
  ACTIVE: "#a8d48f",
  ATTENTION: "#f5c76b",
  SUCCESS: "#74d6a0",
  DANGER: "#ff8e82",
};

export function ControlBadge({ model }: { model: BrowserUiModel }) {
  return (
    <span
      data-tone={model.tone.toLowerCase()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: ".5rem",
        color: colors[model.tone],
        fontSize: ".78rem",
        fontWeight: 750,
        letterSpacing: ".04em",
      }}
    >
      <span aria-hidden="true">●</span>
      {model.label}
    </span>
  );
}
