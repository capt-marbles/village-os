declare global {
  interface Window {
    village?: {
      requestTakeover(): Promise<"QUIESCED" | "OUTCOME_UNKNOWN" | "DECLINED">;
    };
  }
}

const button = document.querySelector<HTMLButtonElement>("#takeover");
const status = document.querySelector<HTMLElement>("#status");

button?.addEventListener("click", async () => {
  if (!window.village || !status) return;
  button.disabled = true;
  status.textContent = "Waiting for the current browser action to stop safely…";
  try {
    const result = await window.village.requestTakeover();
    status.textContent =
      result === "QUIESCED"
        ? "You have control of the local browser."
        : result === "OUTCOME_UNKNOWN"
          ? "The last action is uncertain. Review the browser before continuing."
          : "Takeover was canceled.";
  } catch {
    status.textContent = "Takeover failed safely. Try again.";
  } finally {
    button.disabled = false;
  }
});

export {};
