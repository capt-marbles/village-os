import { app } from "electron";
import { runRitualBuilderApplication } from "./runtime.js";

void runRitualBuilderApplication().catch((error: unknown) => {
  console.error("Village Ritual Builder startup blocked:", error);
  app.exit(1);
});
