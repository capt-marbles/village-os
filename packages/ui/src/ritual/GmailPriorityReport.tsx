import type { RitualRunReceipt } from "@village/contracts";

export function GmailPriorityReport({
  receipt,
}: {
  receipt: RitualRunReceipt;
}) {
  const reports = receipt.stepEvidence.flatMap((step) =>
    step.mailReport ? [step.mailReport] : [],
  );
  if (reports.length === 0) return null;
  return (
    <section aria-label="Gmail inbox priority report">
      {reports.map((report, reportIndex) => (
        <article key={`gmail-priority-${reportIndex + 1}`}>
          <p className="ritual-eyebrow">Metadata-only inbox review</p>
          <h3>{report.headline}</h3>
          <p>{report.summary}</p>
          <ol className="ritual-step-list">
            {report.priorities.map((item) => (
              <li key={item.messageNumber}>
                <span>{String(item.messageNumber).padStart(2, "0")}</span>
                <div>
                  <strong>{item.subject}</strong>
                  <p>{item.reason}</p>
                  <small>
                    {item.priority} · {item.from} ·{" "}
                    {item.receivedAt.slice(0, 10)}
                  </small>
                  <p>{item.responseFocus}</p>
                  {item.uncertainty ? <small>{item.uncertainty}</small> : null}
                </div>
              </li>
            ))}
          </ol>
          <div className="ritual-receipt__uncertainty">
            <h4>What Village did not read</h4>
            <p>{report.uncertainties.join(" ")}</p>
          </div>
        </article>
      ))}
    </section>
  );
}
