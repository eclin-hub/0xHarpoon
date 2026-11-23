// Point d'entrée horaire de l'agent de paper trading (SPEC.md).
//   node scripts/paper.mjs             -> un cycle complet, écrit dans data/paper/
//   node scripts/paper.mjs --dry-run   -> même cycle, n'écrit rien
//   node scripts/paper.mjs --no-net    -> n'appelle aucune API (relevé local seulement)
//   --data=<dossier>                   -> autre dossier de données que ./data
// Étapes branchées : socle, lecture des données, simulateur (funding, résolutions, stops, échéances, valorisation).
// Risque, signaux et IA arrivent ensuite.
import { Store, DEFAULT_DATA_DIR, FILES, utcNow } from "../lib/paper/store.mjs";
import { loadSnapshot, enrich } from "../lib/paper/loader.mjs";
import { tick } from "../lib/paper/simulator.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), noNet = args.includes("--no-net");
const dataDir = args.find((a) => a.startsWith("--data="))?.slice(7) || DEFAULT_DATA_DIR;

const store = new Store(dataDir);
const portfolio = await store.loadPortfolio();
const snap = await loadSnapshot(dataDir);

// données utiles aux positions ouvertes de l'agent
const open = portfolio.positions || [];
const coins = open.filter((p) => p.venue === "hl").map((p) => p.coin);
const tokens = open.filter((p) => p.venue === "pm").map((p) => p.token);
const cids = open.filter((p) => p.venue === "pm").map((p) => p.cid);
const extra = noNet ? { markets: {}, hlBooks: {}, pmBooks: {}, resolutions: {}, errors: [] } : await enrich({ coins, tokens, cids });

const now = Date.now();
const t = tick(portfolio, extra, now);
const next = { ...t.portfolio, lastTick: utcNow(), ticks: (portfolio.ticks || 0) + 1 };

const summary = {
  at: next.lastTick, dryRun: dry,
  snapshot: { ageMin: snap.ageMin == null ? null : Math.round(snap.ageMin), fresh: snap.fresh, hl: snap.hl.length, pm: snap.pm.length, events: snap.events.length },
  portfolio: { equity: t.point.equity, cash: t.point.cash, drawdown: t.point.drawdown, positions: next.positions.length, mode: next.mode },
  trades: t.trades.map((x) => `${x.type} ${x.id} ${x.coin || x.title || x.token} ${x.reason || ""} pnl=${x.pnl == null ? "-" : x.pnl.toFixed(2)}`),
  funding: t.funding.length,
  enrich: noNet ? "désactivé" : { markets: Object.keys(extra.markets).length, hlBooks: Object.keys(extra.hlBooks).length, pmBooks: Object.keys(extra.pmBooks).length, resolutions: Object.keys(extra.resolutions).length },
  problems: [...snap.problems, ...extra.errors, ...t.problems],
};
console.log(JSON.stringify(summary, null, 1));

if (!dry) {
  await store.appendJsonl(FILES.trades, t.trades);
  await store.appendJsonl(FILES.equity, t.point);
  await store.savePortfolio(next);
}
