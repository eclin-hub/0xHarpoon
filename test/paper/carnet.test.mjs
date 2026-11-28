// Statistiques D1 figées (d1Stats) et carnet permanent des stratégies (strategy_ledger.json, league_engine.updateLedger).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLeagues, admitBlueprints, stepLeagues, updateLedger, ledgerStatus, emptyLedger, LEAGUE } from "../../lib/paper/league_engine.mjs";
import { newBook } from "../../lib/paper/blueprint_eval.mjs";
import { FILES, PUBLIC_PAPER_FILES } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3, iso = (t) => new Date(t).toISOString();
const BP = { name: "Retour à la moyenne", thesis: "z-score et RSI.", universe: ["BTC", "ETH"], side: "both", horizon_hours: 24,
  blocks: [{ type: "bollinger_zscore", weight: 0.6, params: { period: 20, z: 2 } }, { type: "rsi", weight: 0.4, params: { period: 14, low: 30, high: 70 } }],
  entry: { score_above: 0.3 }, exit: { stop_atr: 2, take_profit_atr: 3, max_hold_hours: 24 } };
const lib = (id, src = "arxiv") => ({ id, name: `S-${id}`, blueprint: BP, source: { src, author: "A. Martin et al.", url: `https://arxiv.org/abs/${id}` } });
const PASS = () => ({ trades: 40, profitFactor: 1.6, winRate: 0.55, maxDrawdown: 0.06, sharpe: 2, psr: 0.9, stressSurvivalRate: 1 });
const FAIL = () => ({ trades: 40, profitFactor: 0.9, winRate: 0.45, maxDrawdown: 0.2, sharpe: -1, psr: 0.2, stressSurvivalRate: 0.4 });
function fakeBook(n, ret) {
  const b = newBook(10_000);
  for (let k = 0; k < n; k++) b.trades.push({ T: "BTC", pnl: ret * 10_000 * (k % 4 === 3 ? -0.5 : 1), ret: ret * (k % 4 === 3 ? -0.5 : 1) });
  b.returns = Array.from({ length: 40 }, (_, k) => [NOW - (40 - k) * H, k % 2 ? 0.004 : -0.001]);
  Object.assign(b, { equity: 10_000 * (1 + n * ret), peak: 10_000 * (1 + n * ret), lastT: NOW });
  return b;
}

test("d1Stats : figées à l'évaluation D1 et conservées après la promotion en D2 puis en D3, même après une rétrogradation", () => {
  let st = admitBlueprints(emptyLeagues(), [lib("a")], { now: NOW, bench: PASS });
  const e0 = st.entries[0];
  assert.equal(e0.division, "D1Q");
  assert.deepEqual(e0.d1Stats, { trades: 40, profitFactor: 1.6, winRate: 0.55, maxDrawdown: 0.06, sharpe: 2, psr: 0.9, stressSurvivalRate: 1, evaluatedAt: iso(NOW) });
  st = stepLeagues(st, { series: {} }, { now: NOW + H });
  const e1 = st.entries[0];
  assert.equal(e1.division, "D2"); assert.deepEqual(e1.d1Stats, e0.d1Stats);
  // en D2, de bons résultats live : promotion en D3, d1Stats intactes
  e1.d2.book = fakeBook(16, 0.01);
  st = stepLeagues(st, { series: {} }, { now: NOW + 2 * H });
  assert.equal(st.entries[0].division, "D3"); assert.deepEqual(st.entries[0].d1Stats, e0.d1Stats);
  // coupe-circuit : retour en D2, d1Stats toujours là
  st.entries[0].d3.peak = st.entries[0].d2.book.equity / 0.9;
  st = stepLeagues(st, { series: {} }, { now: NOW + 3 * H });
  assert.equal(st.entries[0].division, "D2"); assert.deepEqual(st.entries[0].d1Stats, e0.d1Stats);
  assert.ok(st.entries[0].lastD3?.since); assert.match(st.entries[0].demotedReason, /drawdown/);
  // une stratégie d'un état antérieur (sans d1Stats) les reçoit depuis son bloc d1
  const old = stepLeagues({ ...emptyLeagues(), entries: [{ id: "old", name: "old", blueprint: BP, division: "OUT", d1: { ...FAIL(), at: iso(NOW - 48 * H), progress: 0.5 } }] }, { series: {} }, { now: NOW });
  assert.equal(old.entries[0].d1Stats.profitFactor, 0.9); assert.equal(old.entries[0].d1Stats.evaluatedAt, iso(NOW - 48 * H));
});

test("carnet : initialisé depuis l'état courant ; statuts, dates de passage, bilans et Blueprint complet", () => {
  let calls = 0;
  let st = admitBlueprints(emptyLeagues(), [lib("win"), lib("lose", "x")], { now: NOW, bench: () => (calls++ === 0 ? PASS() : FAIL()) });
  st = stepLeagues(st, { series: {} }, { now: NOW + H });
  const L = updateLedger(null, st, NOW + H);
  const by = Object.fromEntries(L.strategies.map((s) => [s.id, s]));
  assert.equal(L.strategies.length, 2);
  assert.equal(by.win.status, "D2_ACTIVE"); assert.equal(by.lose.status, "D1_OUT");
  assert.equal(by.win.source, "arXiv"); assert.equal(by.lose.source, "X"); assert.equal(by.win.generation, "Gen-1"); assert.equal(by.win.family, "mean_reversion");
  assert.deepEqual(by.win.blueprint, BP); assert.equal(by.win.d1Stats.profitFactor, 1.6);
  assert.equal(by.win.dates.promotedD2At, iso(NOW + H)); assert.equal(by.lose.dates.closedAt, iso(NOW)); assert.match(by.lose.exitReason, /^D1 : /);
  assert.equal(by.win.d2Stats.trades, 0); assert.equal(by.win.d2Stats.final, false);
  for (const k of ["id", "name", "family", "generation", "source", "status", "d1Stats", "d2Stats", "dates", "exitReason", "blueprint"]) assert.ok(k in by.win || k === "exitReason", k);
  assert.equal(L.counts.D2_ACTIVE, 1); assert.equal(L.counts.D1_OUT, 1);
});

test("carnet : persistance non destructive — fiches purgées des ligues conservées, dates écrites une fois, bilans D3 gardés après rétrogradation", () => {
  // cycle 1 : un champion en D3 et une stratégie éliminée en D2
  const champ = { id: "c", name: "Champion", gen: "Gen-2", src: "mutation", parents: ["p1", "p2"], blueprint: BP, createdAt: iso(NOW - 96 * H), division: "D3", family: "mean_reversion",
    d1: { ...PASS(), at: iso(NOW - 96 * H) }, d1Stats: { ...PASS(), evaluatedAt: iso(NOW - 96 * H) },
    d2: { since: iso(NOW - 90 * H), book: fakeBook(16, 0.01), metrics: { trades: 16, profitFactor: 1.8, psr: 0.9, totalReturn: 0.16 } }, d3: { since: iso(NOW - 10 * H), drawdown: 0.02, rollingPsr: 0.8, maxCorr: null, peak: 1 } };
  const loser = { id: "l", name: "Loser", gen: "Gen-1", src: "x", blueprint: BP, createdAt: iso(NOW - 80 * H), division: "OUT", outAt: iso(NOW - 5 * H), outReason: "D2 : PSR 0.2 < 0.35 après 22 trades",
    d1: { ...PASS(), at: iso(NOW - 80 * H) }, d2: { since: iso(NOW - 70 * H), metrics: { trades: 22, profitFactor: 0.7, psr: 0.2, totalReturn: -0.05 } } };
  let L = updateLedger(emptyLedger(), { entries: [champ, loser] }, NOW);
  assert.equal(L.strategies.find((s) => s.id === "c").status, "D3_CHAMPION"); assert.equal(L.strategies.find((s) => s.id === "c").source, "Mutation");
  const l1 = L.strategies.find((s) => s.id === "l");
  assert.equal(l1.status, "D2_OUT"); assert.equal(l1.d2Stats.final, true); assert.equal(l1.dates.closedAt, iso(NOW - 5 * H));
  // aller-retour JSON (fichier sur disque)
  L = JSON.parse(JSON.stringify(L));
  // cycle 2 : l'état des ligues a purgé l'éliminée ; le champion est rétrogradé (d3 = null)
  const demoted = { ...champ, division: "D2", d3: null, demotedAt: iso(NOW + H), demotedReason: "drawdown 9.0 % > 8 %", lastD3: { ...champ.d3, until: iso(NOW + H) },
    d2: { ...champ.d2, since: iso(NOW + 999 * H), metrics: { ...champ.d2.metrics, trades: 18 } } };
  const L2 = updateLedger(L, { entries: [demoted] }, NOW + H);
  assert.equal(L2.strategies.length, 2);                                                      // rien n'est retiré
  assert.deepEqual(L2.strategies.find((s) => s.id === "l"), l1);                              // fiche purgée intacte
  const c2 = L2.strategies.find((s) => s.id === "c");
  assert.equal(c2.status, "D3_RELEGATED"); assert.match(c2.exitReason, /D3 → D2 : drawdown/);
  assert.equal(c2.dates.promotedD2At, iso(NOW - 90 * H));                                    // date de passage écrite une fois
  assert.equal(c2.dates.promotedD3At, iso(NOW - 10 * H)); assert.equal(c2.dates.relegatedD3At, iso(NOW + H));
  assert.equal(c2.d3Stats.rollingPsr, 0.8); assert.equal(c2.d3Stats.until, iso(NOW + H));    // bilan D3 gardé après la rétrogradation
  assert.equal(c2.d2Stats.trades, 18);                                                        // bilan D2 mis à jour
  assert.deepEqual(c2.history.map((x) => x.status), ["D3_CHAMPION", "D3_RELEGATED"]);
  // cycle 3 : état des ligues vide (réinitialisé, corrompu) → le carnet ne perd rien ; mise à jour idempotente
  const L3 = updateLedger(L2, emptyLeagues(), NOW + 2 * H);
  assert.deepEqual(L3.strategies, L2.strategies);
  const L4 = updateLedger(L2, { entries: [demoted] }, NOW + 2 * H);
  assert.deepEqual(L4.strategies.find((s) => s.id === "c").history, c2.history);
  assert.equal(ledgerStatus({ division: "D1Q" }), "D1_QUALIFIED");
});

test("carnet publié : strategy_ledger.json dans les fichiers publics (site et serveur local), jamais purgé par l'état des ligues", () => {
  assert.equal(FILES.ledger, "strategy_ledger.json");
  assert.ok(PUBLIC_PAPER_FILES.includes("strategy_ledger.json"));
  // l'état des ligues garde 60 éliminées ; le carnet en garde autant qu'il en a vu
  const many = Array.from({ length: LEAGUE.outKeep + 15 }, (_, k) => ({ id: `o${k}`, name: `o${k}`, blueprint: BP, division: "OUT", createdAt: iso(NOW - (100 - k) * H), d1: { ...FAIL(), at: iso(NOW - (100 - k) * H) } }));
  const L = updateLedger(null, { entries: many }, NOW);
  const st = stepLeagues({ ...emptyLeagues(), entries: many }, { series: {} }, { now: NOW });
  assert.equal(st.entries.length, LEAGUE.outKeep);
  assert.equal(updateLedger(L, st, NOW + H).strategies.length, LEAGUE.outKeep + 15);
});
