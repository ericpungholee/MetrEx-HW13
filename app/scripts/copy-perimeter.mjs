// Copies the packaged fire perimeter into public/ so the /demo and /create maps can load it.
// Source of truth stays in ../data (Workstream B). The copy is gitignored.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  join(appDir, "..", "data", "palisades-2025.geojson"),
  join(appDir, "..", "data", "raw", "wfigs-palisades-2025.geojson"),
];
const dest = join(appDir, "public", "data", "palisades-2025.geojson");

const src = candidates.find((p) => existsSync(p));
mkdirSync(dirname(dest), { recursive: true });
if (src) {
  copyFileSync(src, dest);
  console.log(`[copy-perimeter] ${src} -> public/data/palisades-2025.geojson`);
} else {
  // Remove any stale copy so the map shows "perimeter unavailable" rather than old data.
  rmSync(dest, { force: true });
  console.warn("[copy-perimeter] No perimeter in ../data yet; the map will show it as unavailable.");
}
