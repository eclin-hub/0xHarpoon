// Traçabilité des votes (explain.mjs), vue publiée des Divisions 2 / 3 (leagueView) et univers élargi à tout Hyperliquid
// et Polymarket (universe.mjs, league_engine.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LLMRouter } from "../../lib/paper/router.mjs";
import { decide } from "../../lib/paper/decision.mjs";
import { executeDecisions } from "../../lib/paper/execute.mjs";
import { openHl } from "../../lib/paper/simulator.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";
import { explainExit, withExplain, humanize } from "../../lib/paper/explain.mjs";
import { buildCatalog, resolveUniverse, normalizeAsset, syntheticAssets, widenUniverse, pmKey } from "../../lib/paper/universe.mjs";
import { validateBlueprint, coerceBlueprint, blueprintPrompt } from "../../lib/paper/blueprint.mjs";
import { emptyLeagues, admitBlueprints, stepLeagues, updateLiveMarket, migrateUniverses, leagueAssets, leagueView, championSignals } from "../../lib/paper/league_engine.mjs";
import { newBook } from "../../lib/paper/blueprint_eval.mjs";
import { runSyntheticBenchmark } from "../../lib/paper/synthetic_market.mjs";
import { catalogPrompt } from "../../lib/paper/universe.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3, iso = (t) => new Date(t).toISOString();
const deep = (px, sz = 1e6) => ({ asks: [[px, sz]], bids: [[px * 0.999, sz]] });

/* ---------- 1. votes de clôture tracés ---------- */

test("clôture par le panel (hors stop) : votes CLOSE / HOLD, poids et raisons enregistrés, phrase de synthèse sur le trade", async () => {
  const opened = openHl(initialPortfolio(), { coin: "ETH", side: "long", usd: 500, stopPx: 90 }, deep(100), NOW - 24 * H).portfolio;
  const id = opened.positions[0].id;
  const said = { a: ["CLOSE", "essoufflement du momentum, funding redevenu positif"], b: ["CLOSE", "la thèse des baleines est invalidée"], c: ["HOLD", "tendance encore intacte"] };
  const providers = [{ name: "p", url: "https://p.test/v1", keyEnv: "K", models: Object.keys(said).map((m) => ({ id: m, family: m })) }];
  const f = async (url, init) => { const m = JSON.parse(init.body).model, [action, reason] = said[m];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ votes: [{ candidate_id: id, action, conviction: 80, invalidation_condition: "repasse sous 95", horizon_hours: 24, cited_risk_metric: "pnl_pct = 0.02", reason }] }) } }] }), { status: 200 }); };
  const router = new LLMRouter({ env: { K: "k" }, providers, fetch: f });
  const d = await decide({ router, dossier: { wakeLLM: true, candidates: [], rejected: [] }, portfolio: opened, markets: { ETH: { mark: 102 } }, now: NOW });
  const dec = d.decisions.find((x) => x.action === "CLOSE");
  assert.ok(dec); assert.equal(dec.votes.n, 3);
  assert.deepEqual(dec.votes.yes.map((v) => v.model).sort(), ["a", "b"]); assert.deepEqual(dec.votes.no.map((v) => [v.model, v.action]), [["c", "HOLD"]]);
  assert.ok(dec.votes.yes.every((v) => v.weight > 0 && v.reason)); assert.equal(Math.round(dec.votes.share * 100), 67);
  assert.match(dec.explain, /^Clôturé par 2\/3 modèles \(67 % du poids\) : /); assert.match(dec.explain, /essoufflement du momentum|thèse des baleines/);
  const ex = await executeDecisions(opened, d.decisions, { candidates: [] }, { markets: { ETH: { mark: 102 } }, deps: { fetchL2Book: async () => deep(102), fetchBook: async () => null }, now: NOW });
  const tr = ex.trades.find((t) => t.type === "close");
  assert.equal(tr.reason, "vote"); assert.equal(tr.explain, dec.explain); assert.equal(tr.votes.yes.length, 2);
  // sorties automatiques : phrase factuelle chiffrée (stop à 2 × ATR, échéance, résolution)
  const stop = withExplain({ type: "close", venue: "hl", side: "long", reason: "stop", entryPx: 100, px: 95.8, stopPx: 96 });
  assert.match(stop.explain, /^Stop-Loss automatique touché à −4,2 % \(stop placé à 4 % de l'entrée, 2 × ATR\)$/);
  assert.match(explainExit({ type: "close", venue: "hl", side: "short", reason: "expiry", entryPx: 100, px: 97 }), /Échéance atteinte.* à \+3,0 %/);
  assert.match(explainExit({ type: "settle", venue: "pm", won: true, entryPx: 0.4, px: 1 }), /pari gagné/);
  assert.equal(withExplain({ type: "open", coin: "BTC" }).explain, undefined);
  assert.equal(humanize("dist_atr = 0.55"), "écart au prix des baleines (en ATR) = 0.55");
});

test("ouverture par le panel : phrase « Ouvert par x/n modèles » gardée sur la position (colonne Avis / Raison)", async () => {
  const cand = { id: "hl|BTC|long", type: "whale", venue: "hl", coin: "BTC", side: "long", pocket: "core", score: 3, metrics: { mark: 100, atr14: 2, dist_atr: 0.55 } };
  const providers = [{ name: "p", url: "https://p.test/v1", keyEnv: "K", models: ["a", "b"].map((m) => ({ id: m, family: m })) }];
  const f = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ votes: [{ candidate_id: cand.id, action: "OPEN", conviction: 82, invalidation_condition: "retour sous 95", horizon_hours: 48, cited_risk_metric: "dist_atr = 0.55", reason: "baleines entrées près du prix actuel" }] }) } }] }), { status: 200 });
  const d = await decide({ router: new LLMRouter({ env: { K: "k" }, providers, fetch: f }), dossier: { wakeLLM: true, candidates: [cand], rejected: [] }, portfolio: initialPortfolio(), now: NOW });
  assert.match(d.decisions[0].explain, /^Ouvert par 2\/2 modèles \(100 % du poids\) : baleines entrées près du prix actuel$/);
  const ex = await executeDecisions(initialPortfolio(), d.decisions, { candidates: [cand] }, { markets: { BTC: { mark: 100 } }, deps: { fetchL2Book: async () => deep(100), fetchBook: async () => null }, now: NOW });
  assert.equal(ex.portfolio.positions[0].openExplain, d.decisions[0].explain);
  assert.equal(ex.trades[0].explain, d.decisions[0].explain);
});

/* ---------- univers élargi ---------- */

const series = (n, start, drift, t0 = NOW - n * H) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * H, c: start * Math.exp(drift * i + 0.002 * Math.sin(i)), h: start * Math.exp(drift * i) * 1.003, l: start * Math.exp(drift * i) * 0.997 }));
const MARKETS = { BTC: { coin: "BTC", mark: 60000, vol: 9e9, oi: 5e9 }, ETH: { coin: "ETH", mark: 1700, vol: 5e9, oi: 2e9 }, DOGE: { coin: "DOGE", mark: 0.2, vol: 8e8, oi: 3e8 },
  kPEPE: { coin: "kPEPE", mark: 0.01, vol: 2e8, oi: 1e8 }, "xyz:CL": { coin: "xyz:CL", mark: 70, vol: 3e8, oi: 2e8 }, "xyz:NVDA": { coin: "xyz:NVDA", mark: 150, vol: 6e8, oi: 4e8 } };
const CID = "0x" + "ab".repeat(32);
const HISTORY = { pm: { [`${CID}|Yes`]: { cid: CID, outcome: "Yes", title: "Will the Fed cut in December?", pts: Array.from({ length: 60 }, (_, i) => [NOW - (59 - i) * H, 0.3 + 0.005 * i]) },   // ≥ 50 barres : le momentum en a besoin
  [`0x${"cd".repeat(32)}|No`]: { cid: "0x" + "cd".repeat(32), outcome: "No", title: "Résolu", pts: Array.from({ length: 30 }, (_, i) => [NOW - (29 - i) * H, 0.995]) } } };

test("univers : symboles Hyperliquid, marchés Polymarket et groupes acceptés ; résolution sur le catalogue du cycle", () => {
  assert.equal(normalizeAsset("xyz:nvda"), "NVDA"); assert.equal(normalizeAsset("kPEPE"), "kPEPE"); assert.equal(normalizeAsset("all-pm"), "ALL_PM");
  assert.equal(normalizeAsset(`PM:${CID.slice(0, 12).toUpperCase()}|Yes`), `PM:${CID.slice(0, 12)}|Yes`); assert.equal(normalizeAsset("!!"), null);
  const bp = coerceBlueprint({ name: "Fed et alts", thesis: "t", universe: ["DOGE", "xyz:CL", `PM:${CID.slice(0, 12)}|Yes`, "HL_TRADFI"], blocks: [{ type: "momentum", weight: 1 }] });
  assert.equal(validateBlueprint(bp).ok, true);
  const cat = buildCatalog({ markets: MARKETS, history: HISTORY, now: NOW });
  assert.equal(cat.hl.length, 6); assert.deepEqual(cat.pm.map((m) => m.key), [pmKey(CID, "Yes")]);   // cote à 0,995 : écartée
  assert.deepEqual(resolveUniverse(bp.universe, cat), ["DOGE", "xyz:CL", pmKey(CID, "Yes"), "NVDA"]);
  assert.deepEqual(resolveUniverse(["HL_CRYPTO"], cat), ["BTC", "ETH", "DOGE", "kPEPE"]);
  assert.deepEqual(resolveUniverse(["ALL_PM", "CL", "UNKNOWN"], cat), [pmKey(CID, "Yes"), "xyz:CL"]);
  assert.match(catalogPrompt(cat), /DOGE.*\n.*xyz:CL[\s\S]*Will the Fed cut/); assert.match(blueprintPrompt(catalogPrompt(cat)), /Available this hour/);
  // labo D1 : proxies synthétiques de même classe
  assert.deepEqual(syntheticAssets(["ALL_PM", "xyz:CL", "xyz:TSLA", "BTC"]), ["PMPROXY", "BRENTOIL", "NVDA", "BTC"]);
  const lab = runSyntheticBenchmark({ ...bp, universe: ["ALL_PM", "DOGE"], side: "both", horizon_hours: 24, entry: { score_above: 0.2 }, exit: { stop_atr: 2, max_hold_hours: 24 } }, 2);
  assert.ok(lab.trades > 0);
});

test("(3) D2 sur des actifs élargis : perps Hyperliquid hors des 8 tickers et cote Polymarket ; migration des anciens Blueprints", () => {
  const BP = { name: "Momentum large", thesis: "Suivre la tendance.", universe: ["HL_CRYPTO", "ALL_PM"], side: "long", horizon_hours: 48,
    blocks: [{ type: "momentum", weight: 1, params: { lookback: 12 } }], entry: { score_above: 0.2 }, exit: { stop_atr: 3, max_hold_hours: 48 } };
  const cat = buildCatalog({ markets: MARKETS, history: HISTORY, now: NOW });
  let st = admitBlueprints(emptyLeagues(), [{ id: "wide", name: "Momentum large", blueprint: BP, source: { src: "x" } }], { now: NOW, bench: () => ({ trades: 40, profitFactor: 1.6, winRate: 0.55, maxDrawdown: 0.05, sharpe: 2, psr: 0.9, stressSurvivalRate: 1 }) });
  const assets = leagueAssets(st, cat);
  assert.deepEqual(assets.sort(), ["DOGE", "kPEPE", pmKey(CID, "Yes")].sort());          // BTC, ETH : séries historiques déjà tenues
  // bougies haussières qui finissent juste sous le prix du cycle
  const candles = { DOGE: series(220, 0.2 / Math.exp(0.44), 0.002), kPEPE: series(220, 0.01 / Math.exp(0.44), 0.002), BTC: series(220, 60000 / Math.exp(0.11), 0.0005), ETH: series(220, 1700 / Math.exp(0.11), 0.0005) };
  const live = updateLiveMarket({ series: {} }, { markets: MARKETS, history: HISTORY, now: NOW, candles, assets });
  assert.ok(live.series.DOGE.c.length >= 220 && live.series[pmKey(CID, "Yes")].c.length === 60);
  st = stepLeagues(st, live, { now: NOW, catalog: cat });
  const e = st.entries[0];
  assert.equal(e.division, "D2"); assert.ok(e.assets.includes("DOGE") && e.assets.includes(pmKey(CID, "Yes")));
  const opened = Object.keys(e.d2.book.positions);
  assert.ok(opened.includes("DOGE"), opened.join()); assert.ok(opened.includes(pmKey(CID, "Yes")), opened.join());   // au-delà des 8 tickers
  assert.ok(championSignals({ ...st, entries: [{ ...e, division: "D3" }] }, live)[0].signals.DOGE != null);
  // exposition totale bornée à 3 × l'équité, quel que soit le nombre d'actifs
  const gross = Object.entries(e.d2.book.positions).reduce((a, [k, q]) => a + q.qty * live.series[k].c.at(-1), 0);
  assert.ok(gross <= 3 * e.d2.book.equity + 1, String(gross));
  // migration : BTC + ETH → + HL_CRYPTO, une seule fois, univers d'origine gardé
  const old = { ...emptyLeagues(), entries: [{ id: "g", name: "GraphFactorStatArb", division: "D2", blueprint: { ...BP, universe: ["BTC", "ETH"] }, d2: { book: newBook() } },
    { id: "o", name: "Out", division: "OUT", blueprint: { ...BP, universe: ["BTC"] } }] };
  const m1 = migrateUniverses(old, NOW), m2 = migrateUniverses(m1, NOW);
  assert.deepEqual(m1.entries[0].blueprint.universe, ["BTC", "ETH", "HL_CRYPTO"]); assert.deepEqual(m1.entries[0].originalUniverse, ["BTC", "ETH"]);
  assert.deepEqual(m1.entries[1].blueprint.universe, ["BTC"]); assert.deepEqual(m2, m1);
  assert.deepEqual(widenUniverse(["NVDA", "BRENTOIL"]), ["NVDA", "BRENTOIL", "HL_TRADFI"]);
});

test("(2) vue publiée D2/D3 : positions ouvertes (entrée, prix, PnL latent, taille) et derniers trades clos (sortie, PnL, motif)", () => {
  const book = newBook(10_000);
  book.positions.DOGE = { dir: 1, qty: 10000, entry: 0.2, fee: 0, stop: 0.19, tp: 0.23, bars: 5, t0: NOW - 5 * H, equity0: 10_000 };
  book.positions[pmKey(CID, "Yes")] = { dir: -1, qty: 2000, entry: 0.6, fee: 0, stop: 0.66, tp: null, bars: 2, t0: NOW - 2 * H, equity0: 10_000 };
  book.trades.push({ T: "xyz:CL", side: "short", entry: 72, exit: 70, pnl: 55.5, ret: 0.0055, bars: 9, reason: "objectif", tOpen: NOW - 20 * H, tClose: NOW - 11 * H });
  const live = { series: { DOGE: { c: [0.21] }, [pmKey(CID, "Yes")]: { c: [0.55] } } };
  const st = { ...emptyLeagues(), entries: [{ id: "s", name: "Strat", division: "D2", blueprint: { universe: ["HL_CRYPTO", "ALL_PM"] }, assets: ["DOGE", pmKey(CID, "Yes")], d2: { book } },
    { id: "z", name: "Éliminée", division: "OUT", blueprint: { universe: ["BTC"] } }] };
  const v = leagueView(st, live, { catalog: buildCatalog({ markets: MARKETS, history: HISTORY, now: NOW }), history: HISTORY, now: NOW });
  assert.equal(v.strategies.length, 1);
  const s = v.strategies[0], doge = s.open.find((o) => o.asset === "DOGE"), pm = s.open.find((o) => o.asset === pmKey(CID, "Yes"));
  assert.equal(doge.side, "long"); assert.equal(doge.pnlPct, 0.05); assert.equal(doge.notional, 2100);
  assert.equal(pm.side, "short"); assert.equal(pm.pnlPct, 0.0833); assert.equal(pm.label, "Will the Fed cut in December? · Yes");
  assert.deepEqual(s.closed[0], { asset: "xyz:CL", label: "xyz:CL", side: "short", entry: 72, exit: 70, pnlPct: 0.0278, pnlUsd: 55.5, reason: "objectif",
    opened: iso(NOW - 20 * H), closed: iso(NOW - 11 * H), bars: 9 });
});
