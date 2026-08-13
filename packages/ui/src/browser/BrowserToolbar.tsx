import {
  browserActionLabel,
  type BrowserUiAction,
  type BrowserUiModel,
} from "./browser-ui-state-matrix.js";
import { ControlBadge } from "./ControlBadge.js";

export function BrowserToolbar({
  model,
  collapsed,
  onAction,
  onCollapsedChange,
  splitRatio = 0.42,
  onSplitRatioChange,
  actionsDisabled = false,
}: {
  model: BrowserUiModel;
  collapsed: boolean;
  onAction?: (action: BrowserUiAction) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  splitRatio?: number;
  onSplitRatioChange?: (splitRatio: number) => void;
  actionsDisabled?: boolean;
}) {
  return (
    <header
      style={{
        display: "flex",
        minHeight: 52,
        alignItems: "center",
        justifyContent: "space-between",
        gap: ".75rem",
        borderBottom: "1px solid #2c352e",
        padding: ".65rem .8rem",
      }}
    >
      <ControlBadge model={model} />
      <div style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
        {!collapsed && model.primaryAction ? (
          <button
            type="button"
            aria-controls="village-browser-surface"
            disabled={!model.primaryEnabled || actionsDisabled}
            onClick={() => onAction?.(model.primaryAction!)}
            style={primaryButtonStyle}
          >
            {browserActionLabel[model.primaryAction]}
          </button>
        ) : null}
        {!collapsed
          ? model.secondaryActions.map((action) => (
              <button
                key={action}
                type="button"
                disabled={actionsDisabled}
                onClick={() => onAction?.(action)}
                style={secondaryButtonStyle}
              >
                {browserActionLabel[action]}
              </button>
            ))
          : null}
        {!collapsed && onSplitRatioChange ? (
          <label style={{ display: "grid", gap: ".15rem", fontSize: ".7rem" }}>
            Pane width
            <input
              type="range"
              aria-label="Browser pane width"
              min="0.3"
              max="0.7"
              step="0.05"
              value={splitRatio}
              onChange={(event) =>
                onSplitRatioChange(Number(event.currentTarget.value))
              }
            />
          </label>
        ) : null}
        <button
          type="button"
          aria-label={
            collapsed ? "Expand browser pane" : "Collapse browser pane"
          }
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange?.(!collapsed)}
          style={iconButtonStyle}
        >
          {collapsed ? "↤" : "↦"}
        </button>
      </div>
    </header>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  minHeight: 40,
  border: "1px solid #a8d48f",
  borderRadius: 999,
  padding: ".55rem .9rem",
  color: "#101410",
  background: "#a8d48f",
  font: "inherit",
  fontWeight: 750,
  cursor: "pointer",
};

const iconButtonStyle: React.CSSProperties = {
  width: 40,
  height: 40,
  border: "1px solid #445047",
  borderRadius: 10,
  color: "#eaf1e8",
  background: "#182019",
  font: "inherit",
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  minHeight: 40,
  border: "1px solid #445047",
  borderRadius: 999,
  padding: ".55rem .8rem",
  color: "#eaf1e8",
  background: "#182019",
  font: "inherit",
  cursor: "pointer",
};
