// Clean up the static asset left by earlier versions of the app.
import { rmSync } from "node:fs";

rmSync(new URL("../public/data/palisades-2025.geojson", import.meta.url), { force: true });
