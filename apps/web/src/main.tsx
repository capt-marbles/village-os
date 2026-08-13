import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { ChatPage } from "./components/chat/ChatPage.js";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Village root element is missing");

createRoot(root).render(
  <StrictMode>
    <ChatPage />
  </StrictMode>,
);
