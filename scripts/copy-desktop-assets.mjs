import { cp, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL(
  "../apps/desktop/src/preload/village-bridge.cjs",
  import.meta.url,
);
const destination = new URL(
  "../apps/desktop/dist/preload/village-bridge.cjs",
  import.meta.url,
);
await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
await cp(source, destination);
