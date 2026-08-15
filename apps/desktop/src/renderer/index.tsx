import { createRoot } from "react-dom/client";
import type { BrowserUiSnapshot } from "@village/ui";
import { DesktopBrowserPane } from "./DesktopBrowserPane.js";
import { PairingBootstrap } from "./PairingBootstrap.js";
import { RitualBuilderPrototype } from "./RitualBuilderPrototype.js";
import { resolveDesktopRendererMode } from "./renderer-mode.js";

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

const rendererMode = resolveDesktopRendererMode(new URL(window.location.href));
if (rendererMode === "PAIRING") document.body.classList.add("pairing-mode");
if (rendererMode === "RITUAL_BUILDER")
  document.body.classList.add("ritual-builder-mode");

createRoot(root).render(
  rendererMode === "PAIRING" ? (
    <PairingBootstrap />
  ) : rendererMode === "RITUAL_BUILDER" ? (
    <RitualBuilderPrototype />
  ) : (
    <DesktopBrowserPane initialSnapshot={initialSnapshot} />
  ),
);
