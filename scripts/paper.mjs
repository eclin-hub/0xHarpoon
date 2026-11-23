// Point d'entrée horaire de l'agent de paper trading (SPEC.md).
//   node scripts/paper.mjs             -> un cycle complet, écrit dans data/paper/
//   node scripts/paper.mjs --dry-run   -> même cycle, n'écrit rien
//   node scripts/paper.mjs --no-net    -> n'appelle aucune API (relevé local seulement)
//   --data=<dossier>                   -> autre dossier de données que ./data
// Étapes déjà branchées : socle + lecture des données. Simulateur, risque, signaux et IA arrivent ensuite.
import { Store, DEFAULT_DATA_DIR, utcNow } from "../lib/paper/store.mjs";
import { loadSnapshot, enrich } from "../lib/paper/loader.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), noNet = args.includes("--no-net");
const dataDir = args.find((a) => a.startsWith("--data="))?.slice(7) || DEFAULT_DATA_DIR;

const store = new Store(dataDir);
const portfolio = await store.loadPortfolio();
const snap = await loadSnapshot(dataDir);

// actifs utiles : positions ouvertes de l'agent (le simulateur en aura besoin à chaque cycle)
const open = portfolio.positions || [];
const coins = open.filter((p) => p.venue === "hl").map((p) => p.coin);
const tokens = open.filter((p) => p.venue === "pm").map((p) => p.token);
const cids = open.filter((p) => p.venue === "pm").map((p) => p.cid);
const extra = noNet ? null : await enrich({ coins, tokens, cids });

const summary = {
  at: utcNow(), dryRun: dry,
  snapshot: { ageMin: snap.ageMin == null ? null : Math.round(snap.ageMin), fresh: snap.fresh, hl: snap.hl.length, pm: snap.pm.length, events: snap.events.length },
  portfolio: { equity: portfolio.equity, cash: portfolio.cash, positions: open.length, mode: portfolio.mode },
  enrich: extra ? { markets: Object.keys(extra.markets).length, atr: Object.keys(extra.ohlc).length, hlBooks: Object.keys(extra.hlBooks).length, pmBooks: Object.keys(extra.pmBooks).length } : "désactivé",
  problems: [...snap.problems, ...(extra?.errors || [])],
};
console.log(JSON.stringify(summary, null, 1));

if (!dry) {
  await store.savePortfolio({ ...portfolio, lastTick: summary.at, ticks: (portfolio.ticks || 0) + 1 });
}
