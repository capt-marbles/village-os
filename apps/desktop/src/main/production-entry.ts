import { app } from "electron";
import { runVillageApplication } from "./runtime.js";

void runVillageApplication().catch((error: unknown) => {
  console.error("Village startup blocked:", error);
  app.exit(1);
});
