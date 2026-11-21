// Serves the app (apps/app, Phase 3 M2) at /ui from its build folder. The page holds no data itself:
// it signs in with the one-time code from `covo app` and then talks to /api like any other client.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Fonts are inlined into the stylesheet (data:), everything else comes from this service.
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Where `bun run app:build` puts the app. COVO_UI_DIR points elsewhere (tests). */
export const defaultUiDir = () => fileURLToPath(new URL("../../../app/dist/", import.meta.url));

const SECURITY = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** Shown when the app hasn't been built (a fresh clone). */
const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Covo</title><style>
:root { color-scheme: light dark; } body { margin: 0; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
main { max-width: 560px; margin: 20vh auto 0; padding: 0 16px; } code { font: 13px ui-monospace, monospace; }
</style></head><body><main>
<h1>Covo</h1>
<p>The app hasn't been built on this Mac yet. In the folder you cloned Covo into, run:</p>
<p><code>bun run app:build</code></p>
<p>Then open it again with <code>covo app</code>.</p>
</main></body></html>`;

/** Hashed file names (from the bundler) never change, so browsers may keep them. */
const HASHED = /-[a-z0-9]{8}\.[a-z0-9]+$/;

/** Answers a GET under /ui/. `rel` is the part after /ui/. */
export async function uiFile(dir: string, rel: string): Promise<Response> {
  const index = join(dir, "index.html");
  if (!existsSync(index)) {
    return new Response(NOT_BUILT, {
      headers: { ...SECURITY, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  let name: string;
  try {
    name = decodeURIComponent(rel);
  } catch {
    return new Response("Not found.", { status: 404, headers: SECURITY });
  }
  const root = resolve(dir);
  const target = resolve(root, name || "index.html");
  if (target !== root && !target.startsWith(root + sep)) {
    return new Response("Not found.", { status: 404, headers: SECURITY });
  }
  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    // A screen's address (e.g. /ui/settings) gets the app; a missing file is a 404.
    if (extname(name)) return new Response("Not found.", { status: 404, headers: SECURITY });
    file = index;
  }
  const f = Bun.file(file);
  return new Response(f, {
    headers: {
      ...SECURITY,
      "content-type": f.type,
      "cache-control": HASHED.test(file) ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}

let built: { file: string; mtime: number; build: string | null } | undefined;

/** The app build the service serves now ("chunk-ab12cd34.js"), from its index.html; null without one. */
export function uiBuild(uiDir: string): string | null {
  const file = join(uiDir, "index.html");
  try {
    const mtime = statSync(file).mtimeMs;
    if (built?.file === file && built.mtime === mtime) return built.build;
    const build = readFileSync(file, "utf8").match(/chunk-[a-z0-9]+\.js/)?.[0] ?? null;
    built = { file, mtime, build };
    return build;
  } catch {
    return null;
  }
}
