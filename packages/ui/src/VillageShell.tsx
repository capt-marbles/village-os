import { setMobilePanel, useMobilePanel } from "./use-mobile-panel.js";

export function VillageShell(): React.JSX.Element {
  const panelOpen = useMobilePanel();
  return (
    <main style={{ minHeight: "100vh", padding: "clamp(1.25rem, 5vw, 4rem)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <p
            style={{
              color: "#8fb89e",
              letterSpacing: ".14em",
              textTransform: "uppercase",
            }}
          >
            Village
          </p>
          <h1 style={{ margin: 0, fontSize: "clamp(2.25rem, 8vw, 5rem)" }}>
            Work that stays yours.
          </h1>
        </div>
        <button
          type="button"
          aria-expanded={panelOpen}
          onClick={() => setMobilePanel(!panelOpen)}
        >
          {panelOpen ? "Close activity" : "Open activity"}
        </button>
      </header>
      <section
        aria-label="Workspace status"
        style={{ marginTop: "4rem", maxWidth: "44rem" }}
      >
        <p>Local browser execution. Durable progress. Your infrastructure.</p>
        {panelOpen ? (
          <aside aria-label="Activity">No active work yet.</aside>
        ) : null}
      </section>
    </main>
  );
}
