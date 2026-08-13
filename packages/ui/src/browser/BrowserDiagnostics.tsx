export interface BrowserDiagnosticEntry {
  component: "SESSION_ERASURE" | "BROWSER_HOST" | "CONTROL_TRANSFER";
  code: string;
  retriable: boolean;
}

export function BrowserDiagnostics({
  entries,
}: {
  entries: readonly BrowserDiagnosticEntry[];
}) {
  return (
    <section aria-labelledby="browser-diagnostics-title">
      <h2 id="browser-diagnostics-title">Local diagnostics</h2>
      <p>Diagnostics stay on this Mac. Uploads are off.</p>
      {entries.length ? (
        <ul>
          {entries.map((entry) => (
            <li key={`${entry.component}:${entry.code}`}>
              <strong>{entry.component.replaceAll("_", " ")}</strong>:{" "}
              {entry.code}
              {entry.retriable ? " — retry available" : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>No local diagnostic events.</p>
      )}
    </section>
  );
}
