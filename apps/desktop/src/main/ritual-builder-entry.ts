import { app } from "electron";
import { runRitualBuilderApplication } from "./runtime.js";
import { claimVillageInstance } from "./single-instance.js";

const launch = claimVillageInstance(app)
  ? runRitualBuilderApplication()
  : Promise.resolve();

void launch.catch((error: unknown) => {
  console.error("Village Ritual Builder startup blocked:", error);
  app.exit(1);
});
