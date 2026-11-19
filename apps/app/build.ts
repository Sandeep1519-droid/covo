// Builds the app into dist/, which Covo's service serves at /ui (Phase 3 M2).
//   bun run build            once
//   bun run build --watch    rebuild on every change (reload the page to see it)
// Bun's own bundler handles TypeScript, React, CSS, fonts and SVGs, so the app needs no other build tools.

import { rmSync, watch } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const outdir = join(root, "dist");

async function build(): Promise<boolean> {
  rmSync(outdir, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: [join(root, "index.html")],
    outdir,
    publicPath: "/ui/",
    minify: true,
    sourcemap: "linked",
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  for (const log of r.logs) console.error(log);
  if (r.success) console.log(`Built the app into ${outdir} (${r.outputs.length} files).`);
  return r.success;
}

const ok = await build();
if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(join(root, "src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void build(), 100);
  });
  console.log("Watching for changes…");
} else if (!ok) {
  process.exit(1);
}
