// Mode One-Way du livre principal (execute.mjs) et plafonds de taille / concentration des stratégies D2 / D3 (blueprint_eval.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDecisions } from "../../lib/paper/execute.mjs";
import { openHl } from "../../lib/paper/simulator.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";
import { newBook, stepBook, SIM } from "../../lib/paper/blueprint_eval.mjs";
import { assetClass } from "../../lib/paper/universe.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3;
const deep = (px, sz = 1e7) => ({ asks: [[px, sz]], bids: [[px * 0.999, sz]] });
const deps = { fetchL2Book: async () => deep(0.2), fetchBook: async () => null };
const cand = (side) => ({ id: `hl|DOGE|${side}`, type: "whale", venue: "hl", coin: "DOGE", side, pocket: "core", score: 3, metrics: { mark: 0.2, atr14: 0.004, dist_atr: 0.5 } });
const openDec = (side) => ({ id: `hl|DOGE|${side}`, action: "OPEN", via: "majorité pondérée 80 %", conviction: 80, horizonH: 24,
  votes: { n: 5, share: 0.8, yes: [{ model: "deepseek-v4-pro", weight: 0.3, action: "OPEN", reason: "cassure baissière" }], no: [] }, explain: "Ouvert par 4/5 modèles (80 % du poids) : cassure baissière" });
const withLong = (heldH) => openHl(initialPortfolio(), { coin: "DOGE", side: "long", usd: 800, stopPx: 0.19, candidateId: "hl|DOGE|long" }, deep(0.2), NOW - heldH * H).portfolio;

test("(1) signal SHORT DOGE alors qu'un LONG DOGE est ouvert : le LONG est clôturé, jamais deux lignes opposées", async () => {
  const p0 = withLong(24);
  assert.equal(p0.positions.length, 1);
  const r = await executeDecisions(p0, [openDec("short")], { candidates: [cand("short")] }, { markets: { DOGE: { mark: 0.2 } }, deps, now: NOW });
  assert.equal(r.portfolio.positions.length, 0);                                           // ni le LONG ni un SHORT : fermé, rien d'ouvert
  const close = r.trades.find((t) => t.type === "close");
  assert.equal(close.side, "long"); assert.equal(close.reason, "signal inverse");
  assert.match(close.explain, /^Clôturé par un signal SHORT opposé validé — voté par 4\/5 modèles/); assert.equal(close.votes.share, 0.8);
  assert.ok(!r.trades.some((t) => t.type === "open"));
  assert.match(r.refused.find((x) => x.id === "hl|DOGE|short").reason, /One-Way : DOGE — position opposée clôturée.*ouverture SHORT au cycle suivant/);
  // cycle suivant, signal toujours SHORT, plus rien en portefeuille : le SHORT s'ouvre (la clôture « signal inverse » ne bloque pas la ré-entrée)
  const r2 = await executeDecisions(r.portfolio, [openDec("short")], { candidates: [cand("short")] }, { markets: { DOGE: { mark: 0.2 } }, deps, now: NOW + H });
  assert.deepEqual(r2.portfolio.positions.map((q) => [q.coin, q.side]), [["DOGE", "short"]]);
});

test("One-Way : même sens → doublon refusé ; position opposée trop récente (< 8 h) → gardée, aucune ligne opposée ouverte", async () => {
  const same = await executeDecisions(withLong(24), [openDec("long")], { candidates: [cand("long")] }, { markets: { DOGE: { mark: 0.2 } }, deps, now: NOW });
  assert.equal(same.portfolio.positions.length, 1); assert.ok(!same.trades.length);
  assert.match(same.refused[0].reason, /One-Way : DOGE LONG déjà ouvert, pas de doublon/);
  const young = await executeDecisions(withLong(2), [openDec("short")], { candidates: [cand("short")] }, { markets: { DOGE: { mark: 0.2 } }, deps, now: NOW });
  assert.deepEqual(young.portfolio.positions.map((q) => q.side), ["long"]); assert.ok(!young.trades.length);
  assert.ok(young.refused.some((x) => /sortie par vote refusée/.test(x.reason)));
});

// marché haussier (ou baissier) régulier sur n actifs : un signal de momentum dans le même sens partout
function market(keys, drift = 0.004, n = 120) {
  const out = {};
  for (const [j, k] of keys.entries()) {
    const c = Array.from({ length: n }, (_, i) => 100 * Math.exp(drift * i + 0.003 * Math.sin(i + j)));
    out[k] = { t: c.map((_, i) => i * H), c, h: c.map((x) => x * 1.002), l: c.map((x) => x * 0.998), funding: c.map(() => 0), xVel: c.map(() => 1), xBias: c.map(() => 0), pm: c.map(() => 0) };
  }
  return out;
}
const BP = (universe, extra = {}) => ({ name: "Momentum", thesis: "t", universe, side: "both", horizon_hours: 48, blocks: [{ type: "momentum", weight: 1, params: { lookback: 12 } }],
  entry: { score_above: 0.1 }, exit: { stop_atr: 0.5, max_hold_hours: 48 }, ...extra });

test("(2) D2 sur 10 000 $ : position ≤ 1 500 $ (15 %), exposition brute ≤ 6 000 $ (60 %), 4 positions au plus, 3 du même sens par classe", () => {
  assert.deepEqual([SIM.maxNotional, SIM.maxGross, SIM.maxPositions, SIM.maxSameDirPerClass], [0.15, 0.6, 4, 3]);
  const crypto = ["BTC", "ETH", "SOL", "DOGE", "AVAX", "NEAR", "LINK"], tradfi = ["xyz:CL", "xyz:TSLA"];
  const mk = market([...crypto, ...tradfi]), i = 119, b = newBook(10_000);
  stepBook(b, BP([...crypto, ...tradfi]), mk, i, NOW);
  const pos = Object.entries(b.positions), notional = ([K, q]) => q.qty * mk[K].c[i];
  assert.ok(pos.length <= 4, String(pos.length));
  assert.ok(pos.every((x) => notional(x) <= 1500 + 1e-6), pos.map((x) => Math.round(notional(x))).join());
  assert.ok(pos.reduce((a, x) => a + notional(x), 0) <= 6000 + 1e-6);
  const longCrypto = pos.filter(([K, q]) => assetClass(K) === "crypto" && q.dir > 0).length;
  assert.equal(longCrypto, 3);                                                            // jamais plus de 3 LONG crypto à la fois
  assert.equal(pos.length, 4); assert.equal(assetClass(pos.find(([K]) => assetClass(K) !== "crypto")[0]), "tradfi");   // la 4e place va à une autre classe
  assert.ok(b.capped > 0);
  // une seule position sur un gros risque par trade : bornée à 15 % même si le stop est très proche
  const one = newBook(10_000);
  stepBook(one, BP(["BTC"], { exit: { stop_atr: 0.5, max_hold_hours: 48 } }), market(["BTC"]), i, NOW);
  assert.ok(Math.abs(one.positions.BTC.qty * market(["BTC"]).BTC.c[i] - 1500) < 1);
});

test("(3) stat_arb_leadlag : pas de 3e jambe LONG crypto sans jambe SHORT ; une jambe SHORT rouvre la place", () => {
  const crypto = ["BTC", "ETH", "SOL", "DOGE"], up = market(crypto), i = 119;
  const b = newBook(10_000);
  stepBook(b, BP(crypto, { family: "stat_arb_leadlag" }), up, i, NOW);
  assert.equal(Object.keys(b.positions).length, 2); assert.ok(Object.values(b.positions).every((q) => q.dir > 0));
  // une jambe SHORT crypto ouverte (actif baissier) : la 3e LONG redevient possible
  const mixed = { ...market(["BTC", "ETH", "SOL"]), DOGE: market(["DOGE"], -0.004).DOGE }, b2 = newBook(10_000);
  stepBook(b2, BP(["DOGE", "BTC", "ETH", "SOL"], { family: "stat_arb_leadlag" }), mixed, i, NOW);
  const dirs = Object.values(b2.positions).map((q) => q.dir);
  assert.equal(dirs.filter((d) => d < 0).length, 1); assert.equal(dirs.filter((d) => d > 0).length, 3);
  // une autre famille n'est pas concernée par l'équilibrage (3 LONG crypto)
  const b3 = newBook(10_000);
  stepBook(b3, BP(crypto, { family: "trend_breakout" }), up, i, NOW);
  assert.equal(Object.keys(b3.positions).length, 3);
});

test("mise aux plafonds d'un carnet déjà ouvert (une fois) : positions réduites à 15 %, excès fermés (les plus récents), journalisé", async () => {
  const { enforceCaps } = await import("../../lib/paper/blueprint_eval.mjs");
  const { stepLeagues, emptyLeagues } = await import("../../lib/paper/league_engine.mjs");
  const keys = ["BTC", "ETH", "HYPE", "ZEC", "NEAR"], mk = market(keys, 0), i = 119, px = (K) => mk[K].c[i];
  // carnet pris sous les anciennes règles : 5 LONG crypto de ~5 000 $
  const old = () => { const b = newBook(10_000); keys.forEach((K, k) => { b.positions[K] = { dir: 1, qty: 5000 / px(K), entry: px(K), fee: 1.75, stop: px(K) * 0.9, tp: null, bars: 3, t0: NOW - (10 - k) * H, equity0: 10_000 }; b.cash -= 1.75; }); return b; };
  const b = old(), n = enforceCaps(b, { family: "stat_arb_leadlag" }, mk, i, NOW);
  assert.ok(n > 0);
  assert.deepEqual(Object.keys(b.positions), ["BTC", "ETH"]);                              // les 2 plus anciennes gardées, sans jambe SHORT
  for (const [K, q] of Object.entries(b.positions)) assert.ok(q.qty * px(K) <= 1500 + 1e-6);
  assert.equal(b.trades.filter((t) => t.reason === "plafond de concentration").length, 3);
  assert.equal(b.trades.filter((t) => t.partial).length, 5);
  assert.equal(enforceCaps(b, { family: "stat_arb_leadlag" }, mk, i, NOW), 0);            // déjà conforme : rien
  // autre famille : 3 LONG crypto au plus (la plus récente fermée)
  const c = old(); enforceCaps(c, { family: "trend_breakout" }, mk, i, NOW);
  assert.deepEqual(Object.keys(c.positions), ["BTC", "ETH", "HYPE"]);
  // dans la ligue : appliqué une seule fois par stratégie (capsV), noté dans le journal
  const live = { series: mk }, d2 = { id: "g", name: "GraphFactorStatArb", division: "D2", family: "stat_arb_leadlag", familyV: 2,
    blueprint: { name: "GraphFactorStatArb", thesis: "arbitrage statistique", universe: keys, side: "both", horizon_hours: 24, blocks: [{ type: "momentum", weight: 1, params: {} }], entry: { score_above: 0.9 }, exit: { stop_atr: 2, max_hold_hours: 24 } },
    d2: { since: new Date(NOW - 48 * H).toISOString(), book: old(), metrics: null } };
  const st = stepLeagues({ ...emptyLeagues(), entries: [d2] }, live, { now: NOW });
  assert.equal(Object.keys(st.entries[0].d2.book.positions).length, 2); assert.equal(st.entries[0].capsV, 2);
  assert.match(st.log[0].msg, /mises aux plafonds.*5 → 2 position/);
});
