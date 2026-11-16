// Fabrique une page autonome (sans serveur) avec les données du moment.
//   node scripts/snapshot.mjs            -> dist/snapshot.html (document complet)
//   node scripts/snapshot.mjs --artifact -> dist/snapshot-fragment.html (sans <html>/<body>, pour une plateforme qui enveloppe la page)
//   node scripts/snapshot.mjs --site     -> site/ (index.html + state.json), pour GitHub Pages : la page relit state.json toute seule
// Si un serveur tourne (PORT, 8787 par défaut), il est interrogé. Sinon les sources sont collectées directement (15 à 20 s).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || 8787;
let raw;
const base = `http://localhost:${port}`;
let res = process.argv.includes("--site") ? null : await fetch(`${base}/api/refresh`, { method: "POST" }).catch(() => null);
if (process.argv.includes("--site")) res = null;           // en ligne : toujours une collecte complète et autonome
if (res && !res.ok) res = await fetch(`${base}/api/state`).catch(() => null);   // actualisé à l'instant : on prend l'état courant
const reuse = process.argv.includes("--reuse") ? await readFile(path.join(root, "site", "state.json"), "utf8").catch(() => null) : null;   // --reuse : reconstruit la page sans nouvelle collecte
if (reuse) raw = reuse;
else if (res?.ok) raw = await res.text();
else {
  const srv = await import("../server.mjs");               // n'écoute aucun port quand il est importé
  await srv.loadDisk();
  await srv.refreshAll(true);
  raw = JSON.stringify(srv.publicState());
  await srv.saveDisk();
}
const data = raw.replace(/</g, "\\u003c");
const pub = (f) => readFile(path.join(root, "public", f), "utf8");
let html = await pub("index.html");
const css = await pub("app.css");
const files = ["vendor/d3.min.js", "vendor/topojson-client.min.js", "charts.js", "charts2.js", "geodata.js", "globe.js", "core.js", "drawer.js", "pmapi.js", "pmwhale.js", "views1.js", "views2.js", "views3.js", "views4.js", "tape.js", "main.js", "live.js", "q-model.js", "q-canvas.js", "q-tools.js", "q-hidden.js", "q-thesis.js", "q-vault.js"];
const world = (await pub("vendor/world.json")).replace(/</g, "\\u003c");
const js = (await Promise.all(files.map(pub))).map((c) => `<script>\n${c}\n</script>`).join("\n");
html = html.replace(/<link rel="stylesheet" href="app\.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script src="vendor\/d3\.min\.js"><\/script>[\s\S]*<script src="q-vault\.js"><\/script>/, () => `<script>window.__SNAPSHOT__=${data};${process.argv.includes("--site") ? "window.__PAGES__=true;" : ""}window.__WORLD__=${world};</script>\n${js}`);
await mkdir(path.join(root, "dist"), { recursive: true });
if (process.argv.includes("--site")) {
  const site = path.join(root, "site");
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, "index.html"), html);
  await writeFile(path.join(site, "state.json"), raw);
  await writeFile(path.join(site, ".nojekyll"), "");
  // positions complètes de la dernière collecte : la page s'en sert pour montrer ce qui a bougé depuis
  try { const last = JSON.parse(await readFile(path.join(root, "data", "last.json"), "utf8")); await writeFile(path.join(site, "positions.json"), JSON.stringify({ at: last.at, hl: last.hl })); } catch {}
  console.log("site/index.html", (html.length / 1024) | 0, "KB · site/state.json", (raw.length / 1024) | 0, "KB");
} else if (process.argv.includes("--artifact")) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*/g, "");
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  html = `${head.replace("<title>", '<meta name="claude:viewport-fit-sides" content="cover">\n<title>')}\n${body}`;
  await writeFile(path.join(root, "dist/snapshot-fragment.html"), html);
  console.log("dist/snapshot-fragment.html", (html.length / 1024) | 0, "KB");
} else { await writeFile(path.join(root, "dist/snapshot.html"), html); console.log("dist/snapshot.html", (html.length / 1024) | 0, "KB"); }
process.exit(0);
