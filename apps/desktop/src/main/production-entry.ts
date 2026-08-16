import { app } from "electron";
import {
  runRitualBuilderApplication,
  runVillageApplication,
} from "./runtime.js";
import { resolveRuntimeSurface } from "./runtime-surface.js";
import { claimVillageInstance } from "./single-instance.js";

const launch = claimVillageInstance(app)
  ? resolveRuntimeSurface(process.argv) === "RITUAL_BUILDER"
    ? runRitualBuilderApplication()
    : runVillageApplication()
  : Promise.resolve();

void launch.catch((error: unknown) => {
  console.error("Village startup blocked:", error);
  app.exit(1);
});
