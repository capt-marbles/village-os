import { cp, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const internal = process.env.VILLAGE_BUILD_CHANNEL !== "release";
const source = new URL(
  internal
    ? "../apps/desktop/src/preload/village-bridge.internal.cjs"
    : "../apps/desktop/src/preload/village-bridge.cjs",
  import.meta.url,
);
const destination = new URL(
  "../apps/desktop/dist/preload/village-bridge.cjs",
  import.meta.url,
);
await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
await cp(source, destination);
await cp(
  new URL(
    "../apps/desktop/src/preload/ritual-builder-bridge.cjs",
    import.meta.url,
  ),
  new URL(
    "../apps/desktop/dist/preload/ritual-builder-bridge.cjs",
    import.meta.url,
  ),
);
