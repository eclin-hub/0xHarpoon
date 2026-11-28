// Test réel de bout en bout du flux ∞, sans rien écrire dans data/ : vrais abstracts arXiv q-fin (x_free.mjs), tri et
// score d'intérêt (x_scraper.mjs), compilation par Groq (qwen/qwen3.8-27b puis openai/gpt-oss-120b), validation stricte,
// puis admission en Division 1 (league_engine.mjs, laboratoire synthétique).
//   GROQ_API_KEY=… node scripts/blueprint_smoke.mjs [--n 3]
// Sans GROQ_API_KEY : collecte et tri seulement (dit combien de posts seraient compilés).
import { collectFree } from "../lib/paper/x_free.mjs";
import { ingest, updateLibrary, blueprintExtractor, interestMinOf, X_CONFIG } from "../lib/paper/x_scraper.mjs";
import { emptyLeagues, admitBlueprints } from "../lib/paper/league_engine.mjs";

const argN = process.argv.indexOf("--n"), n = argN > 0 ? Number(process.argv[argN + 1]) || 3 : 3;
const now = Date.now();
const fr = await collectFree({ feeds: [] });
if (fr.notes.length) console.warn("notes collecte :", fr.notes.join(" ; "));
const { cache, stats } = ingest(fr.posts, {}, { now });
const inf = Object.values(cache.posts).filter((p) => p.kind === "infinity").sort((a, b) => b.interest - a.interest);
console.log(`arXiv : ${fr.counts.arxiv} abstracts retenus, ${stats.infinity} en flux ∞ ; seuils X ${X_CONFIG.interestMin} / arXiv ${X_CONFIG.interestMinArxiv}`);
for (const p of inf) console.log(`  ${String(p.interest).padStart(3)} ${p.interest >= interestMinOf(p) ? "✓" : "·"} ${p.id}  ${p.text.slice(0, 90)}`);

const extract = blueprintExtractor();
if (!extract) { console.log("\nGROQ_API_KEY absente : compilation non testée."); process.exit(0); }
const cfg = { ...X_CONFIG, maxBlueprintsBootstrap: n, maxBlueprintsPerCycle: n };
const t0 = Date.now();
const lib = await updateLibrary([], cache, extract, { now, cfg });
console.log(`\nCompilation Groq (${((Date.now() - t0) / 1000).toFixed(1)} s) :`);
for (const note of lib.notes) console.log("  " + note);
for (const b of lib.library) console.log(`  ✓ ${b.model} → « ${b.name} » ${b.blueprint.side} ${b.blueprint.universe.join(",")} [${b.blueprint.blocks.map((x) => x.type).join(", ")}]`);

const st = admitBlueprints(emptyLeagues(), lib.library, { now });
console.log(`\nDivision 1 : ${st.entries.length} Blueprint(s) admis`);
for (const e of st.entries) console.log(`  ${e.division}  ${e.name}  ${JSON.stringify(e.d1 ?? e.metrics ?? {}).slice(0, 160)}`);
process.exit(lib.library.length >= Math.min(2, n) && st.entries.length === lib.library.length ? 0 : 1);
