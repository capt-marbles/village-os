import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VillageShell } from "@village/ui";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Village root element is missing");

createRoot(root).render(
  <StrictMode>
    <VillageShell />
  </StrictMode>,
);
