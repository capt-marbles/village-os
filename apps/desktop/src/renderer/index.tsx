import { createRoot } from "react-dom/client";
import type { BrowserUiSnapshot } from "@village/ui";
import { DesktopBrowserPane } from "./DesktopBrowserPane.js";
import { PairingBootstrap } from "./PairingBootstrap.js";

const initialSnapshot: BrowserUiSnapshot = {
  surface: "DESKTOP",
  jobState: "WAITING_FOR_BROWSER",
  controller: "NONE",
  connection: "ABSENT",
  takeover: "NONE",
  pairing: "RECOVERING",
  verification: "unknown",
  profile: "PRESENT",
  humanGate: null,
  erasure: "IDLE",
  lastUpdatedAt: new Date().toISOString(),
};

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Village desktop root is missing");

const pairingMode =
  new URL(window.location.href).searchParams.get("mode") === "pairing";
if (pairingMode) document.body.classList.add("pairing-mode");

createRoot(root).render(
  pairingMode ? (
    <PairingBootstrap />
  ) : (
    <DesktopBrowserPane initialSnapshot={initialSnapshot} />
  ),
);
