import { app } from "electron";
import {
  runRitualBuilderApplication,
  runVillageApplication,
} from "./runtime.js";
import { resolveRuntimeSurface } from "./runtime-surface.js";

const launch =
  resolveRuntimeSurface(process.argv) === "RITUAL_BUILDER"
    ? runRitualBuilderApplication()
    : runVillageApplication();

void launch.catch((error: unknown) => {
  console.error("Village startup blocked:", error);
  app.exit(1);
});
