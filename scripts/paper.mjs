// Point d'entrée horaire de l'agent de paper trading (SPEC.md).
//   node scripts/paper.mjs             -> un cycle complet, écrit dans data/paper/
//   node scripts/paper.mjs --dry-run   -> même cycle, n'écrit rien
//   node scripts/paper.mjs --no-net    -> n'appelle aucune API (relevé local seulement)
//   --data=<dossier>                   -> autre dossier de données que ./data
// Étapes branchées : socle, données, simulateur (funding, résolutions, stops, échéances, valorisation),
// freins de drawdown, notes des baleines. Signaux et IA arrivent ensuite.
import { Store, DEFAULT_DATA_DIR, FILES, utcNow } from "../lib/paper/store.mjs";
import { loadSnapshot, enrich, fetchPriorSources } from "../lib/paper/loader.mjs";
import { tick } from "../lib/paper/simulator.mjs";
import { emptyScores, updateScores, setPriors, priorsFromHl, priorsFromPm, keyOf } from "../lib/paper/scorer.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), noNet = args.includes("--no-net");
const dataDir = args.find((a) => a.startsWith("--data="))?.slice(7) || DEFAULT_DATA_DIR;
const PRIORS_EVERY = 24 * 3600e3;

const now = Date.now();
const store = new Store(dataDir);
const portfolio = await store.loadPortfolio();
let scores = (await store.readJson(FILES.whaleScores)) ?? emptyScores(now);
const snap = await loadSnapshot(dataDir, now);

// données utiles : positions ouvertes de l'agent + marchés des baleines Polymarket fermées depuis le dernier cycle
const open = portfolio.positions || [];
const coins = open.filter((p) => p.venue === "hl").map((p) => p.coin);
const tokens = open.filter((p) => p.venue === "pm").map((p) => p.token);
const newPmCloses = snap.events.filter((e) => e.t > scores.cursor && e.kind === "close" && e.src === "pm" && e.cid);
const cids = [...open.filter((p) => p.venue === "pm").map((p) => p.cid), ...newPmCloses.map((e) => e.cid)];
const extra = noNet ? { markets: {}, hlBooks: {}, pmBooks: {}, resolutions: {}, errors: [] } : await enrich({ coins, tokens, cids });
const problems = [...snap.problems, ...extra.errors];

// notes des baleines : poids de départ une fois par jour (baleines du relevé seulement), puis fermetures récentes
if (!noNet && (!scores.priorsAt || now - Date.parse(scores.priorsAt) > PRIORS_EVERY) && (snap.hl.length || snap.pm.length)) {
  const src = await fetchPriorSources();
  const known = new Set([...snap.hl.map((a) => keyOf("hl", a.addr)), ...snap.pm.map((w) => keyOf("pm", w.addr))]);
  const all = { ...priorsFromHl(src.hlRows), ...priorsFromPm(src.pmBoards) };
  scores = { ...setPriors(scores, Object.fromEntries(Object.entries(all).filter(([k]) => known.has(k)))), priorsAt: new Date(now).toISOString() };
  problems.push(...src.errors);
}
const sc = updateScores(scores, snap.events, { resolutions: extra.resolutions });
scores = sc.scores;

const t = tick(portfolio, extra, now);
const next = { ...t.portfolio, lastTick: utcNow(), ticks: (portfolio.ticks || 0) + 1 };
problems.push(...t.problems);

const summary = {
  at: next.lastTick, dryRun: dry,
  snapshot: { ageMin: snap.ageMin == null ? null : Math.round(snap.ageMin), fresh: snap.fresh, hl: snap.hl.length, pm: snap.pm.length, events: snap.events.length },
  portfolio: { equity: t.point.equity, cash: t.point.cash, drawdown: t.point.drawdown, positions: next.positions.length, mode: next.mode },
  trades: t.trades.map((x) => `${x.type} ${x.id || ""} ${x.coin || x.title || x.token || x.to || ""} ${x.reason || ""} pnl=${x.pnl == null ? "-" : x.pnl.toFixed(2)}`),
  funding: t.funding.length,
  whales: { tracked: Object.keys(scores.whales).length, newOutcomes: sc.applied.length, skipped: sc.skipped.length, warmupEndsAt: scores.warmupEndsAt },
  enrich: noNet ? "désactivé" : { markets: Object.keys(extra.markets).length, hlBooks: Object.keys(extra.hlBooks).length, pmBooks: Object.keys(extra.pmBooks).length, resolutions: Object.keys(extra.resolutions).length },
  problems,
};
console.log(JSON.stringify(summary, null, 1));

if (!dry) {
  await store.appendJsonl(FILES.trades, t.trades);
  await store.appendJsonl(FILES.equity, t.point);
  await store.writeJson(FILES.whaleScores, scores);
  await store.savePortfolio(next);
}
