import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyScores } from "../../lib/paper/scorer.mjs";
import { netRatio, gatherHl, finalizeHl, liquidationWall, gatherPm, finalizePm, selectCandidates } from "../../lib/paper/candidates.mjs";
import { coinSentiment, correlation, partnersOf, findPairs, updateHistory, movedMarkets, detectLeadLag, emptyHistory } from "../../lib/paper/cross.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const NOW = Date.UTC(2026, 10, 24, 12);
const H = 3600e3, DAY = 86400e3;
const scores = emptyScores(NOW - DAY);   // phase de démarrage : poids 1, baleines admises

const pos = (coin, side, notional, entry, liq = null) => ({ coin, side, notional, entry, liq, size: notional / entry });
const acct = (addr, equity, positions, longN, shortN) => ({ addr, equity, positions,
  longN: longN ?? positions.filter((p) => p.side === "long").reduce((s, p) => s + p.notional, 0),
  shortN: shortN ?? positions.filter((p) => p.side === "short").reduce((s, p) => s + p.notional, 0) });
const hlSnap = (over = {}) => ({
  hl: [
    acct("0xA", 1e6, [pos("BTC", "long", 300_000, 100, 80)]),
    acct("0xB", 2e6, [pos("BTC", "long", 200_000, 102, 95)]),
    acct("0xC", 1e7, [pos("BTC", "long", 100_000, 101)]),                        // 1 % de l'equity : trop petit
    acct("0xD", 2e6, [pos("BTC", "long", 500_000, 99, 90)], 500_000, 450_000),     // compte couvert
    acct("0xE", 1e6, [pos("ETH", "short", 200_000, 50)]),
  ],
  pm: [],
  events: [
    { t: NOW - 1 * H, src: "hl", kind: "open", addr: "0xA", coin: "BTC", side: "long" },
    { t: NOW - 3 * H, src: "hl", kind: "add", addr: "0xB", coin: "BTC", side: "long" },
    { t: NOW - 1 * H, src: "hl", kind: "open", addr: "0xC", coin: "BTC", side: "long" },
    { t: NOW - 5 * H, src: "hl", kind: "open", addr: "0xE", coin: "ETH", side: "short" },   // hors fenêtre de 4 h
  ],
  ...over,
});
const MK = { BTC: { mark: 103, funding: -0.00001, oi: 1e9 }, ETH: { mark: 51, funding: 0 } };
const OH = { BTC: { atr: 4, atrPct: 0.04 }, ETH: { atr: 2, atrPct: 0.04 } };

test("netRatio : comptes couverts", () => {
  close(netRatio({ longN: 500, shortN: 450 }), 50 / 950);
  assert.equal(netRatio({}), 0);
});

test("gatherHl : baleines qualifiées, convergence sur entrées récentes seulement", () => {
  const g = gatherHl(hlSnap(), scores, NOW);
  assert.deepEqual(g.pass.map((x) => x.id), ["hl|BTC|long"]);
  const btc = g.pass[0];
  assert.deepEqual(btc.holders.map((h) => h.addr), ["0xA", "0xB"]);
  assert.deepEqual(btc.excluded.map((h) => h.why.split(" ")[0]), ["position", "compte"]);
  assert.equal(btc.nTriggers, 2); close(btc.prescore, 2);
  assert.equal(g.rejected.length, 0);   // ETH : aucune entrée dans la fenêtre, pas même signalé
  const one = gatherHl(hlSnap({ events: [{ t: NOW - H, src: "hl", kind: "open", addr: "0xE", coin: "ETH", side: "short" }] }), scores, NOW);
  assert.match(one.rejected[0].reason, /1 baleine qualifiée entrée en 4 h/);
});

test("finalizeHl : fraîcheur, bonus contrariant, score", () => {
  const g = gatherHl(hlSnap(), scores, NOW).pass[0];
  const r = finalizeHl(g, { markets: MK, ohlc: OH }, hlSnap().hl);
  assert.equal(r.ok, true);
  const m = r.cand.metrics;
  close(m.whales_vwap_entry, 100.8); close(m.dist_atr, 0.55); assert.equal(m.contrarian, true);
  close(r.cand.score, 2 * 1.2 * (1 - 0.5 * 0.55 / 1.2), 1e-4);
  assert.equal(r.cand.whales[0].addr, "0xA…0xA");   // adresse abrégée (6 premiers + 4 derniers caractères)
  // le prix est déjà parti : 1,3 ATR au-dessus de l'entrée des baleines
  assert.match(finalizeHl(g, { markets: { BTC: { ...MK.BTC, mark: 106 } }, ohlc: OH }, []).reason, /fraîcheur : prix à 1\.30 ATR/);
  assert.match(finalizeHl(g, { markets: MK, ohlc: {} }, []).reason, /ATR manquant/);
});

test("finalizeHl : trade encombré = funding extrême + mur de liquidations", () => {
  const snap = hlSnap();
  snap.hl[1].positions[0].liq = 100; snap.hl[3].positions[0].liq = 101;   // 700 k$ sur 1,1 M$ liquidables entre 99 et 103
  const wall = liquidationWall(snap.hl, "BTC", "long", 103, 4);
  close(wall.share, 700_000 / 1_100_000);
  const g = gatherHl(snap, scores, NOW).pass[0];
  assert.match(finalizeHl(g, { markets: { BTC: { mark: 103, funding: 0.0001 } }, ohlc: OH }, snap.hl).reason, /trade encombré/);
  // funding extrême sans mur : accepté, sans bonus
  const ok = finalizeHl(g, { markets: { BTC: { mark: 103, funding: 0.0001 } }, ohlc: OH }, hlSnap().hl);
  assert.equal(ok.ok, true); assert.equal(ok.cand.metrics.contrarian, false);
  close(liquidationWall([acct("x", 1, [pos("ETH", "short", 100, 50, 52)])], "ETH", "short", 51, 2).share, 1);
});

const pmPos = (cid, outcome, price, avg, value, extra = {}) => ({ cid, outcome, price, avg, value, token: "tok-" + cid, title: "Will Bitcoin reach $150k?", category: "crypto", end: new Date(NOW + 30 * DAY).toISOString(), ...extra });
const pmSnap = (p1, p2) => ({
  hl: [],
  pm: [
    { addr: "w1", positions: [p1, pmPos("c9", "Yes", 0.5, 0.5, 90_000, { title: "Lakers vs Celtics", category: "sports" })] },
    { addr: "w2", positions: [p2] },
  ],
  events: [
    { t: NOW - H, src: "pm", kind: "open", addr: "w1", cid: p1.cid, outcome: "Yes" },
    { t: NOW - 2 * H, src: "pm", kind: "add", addr: "w2", cid: p2.cid, outcome: "Yes" },
  ],
});

test("gatherPm + finalizePm : poche cœur, fraîcheur, sport exclu", () => {
  const g = gatherPm(pmSnap(pmPos("c1", "Yes", 0.5, 0.45, 10_000), pmPos("c1", "Yes", 0.5, 0.48, 20_000)), scores, NOW);
  assert.deepEqual(g.pass.map((x) => x.id), ["pm|c1|Yes"]);
  close(g.pass[0].holders[0].share, 0.1);
  const r = finalizePm(g.pass[0], NOW);
  close(r.cand.metrics.whales_avg_price, 0.47); close(r.cand.metrics.delta_vs_whales, 0.03);
  assert.equal(r.cand.pocket, "core"); close(r.cand.score, 2 * (1 - 0.5 * 0.03 / 0.1), 1e-4); assert.equal(r.cand.token, "tok-c1");
  const late = gatherPm(pmSnap(pmPos("c1", "Yes", 0.6, 0.45, 10_000), pmPos("c1", "Yes", 0.6, 0.48, 20_000)), scores, NOW).pass[0];
  assert.match(finalizePm(late, NOW).reason, /fraîcheur/);
});

test("finalizePm : cote 0,88 – 0,95 à moins de 14 jours → poche portage", () => {
  const end = new Date(NOW + 5 * DAY).toISOString();
  const g = gatherPm(pmSnap(pmPos("c2", "Yes", 0.9, 0.88, 10_000, { end }), pmPos("c2", "Yes", 0.9, 0.88, 20_000, { end })), scores, NOW).pass[0];
  const r = finalizePm(g, NOW);
  assert.equal(r.cand.pocket, "portage"); close(r.cand.metrics.days_to_end, 5);
  const hi = gatherPm(pmSnap(pmPos("c3", "Yes", 0.97, 0.96, 10_000), pmPos("c3", "Yes", 0.97, 0.96, 20_000)), scores, NOW).pass[0];
  assert.match(finalizePm(hi, NOW).reason, /plus assez d'avantage/);
});

test("selectCandidates : 5 meilleurs, déjà en portefeuille écarté, réveil des LLM", () => {
  const mk = (id, score) => ({ id, type: "whale", score });
  const list = [mk("hl|BTC|long", 3), ...Array.from({ length: 6 }, (_, i) => mk(`hl|C${i}|long`, 1 + i / 10))];
  const p = { ...initialPortfolio(), positions: [{ venue: "hl", coin: "BTC", side: "long" }] };
  const s = selectCandidates(list, p);
  assert.equal(s.candidates.length, 5); assert.equal(s.candidates[0].id, "hl|C5|long");
  assert.deepEqual(s.rejected.map((r) => r.reason.split(" ")[0]), ["déjà", "hors"]);
  assert.equal(s.wakeLLM, false);
  assert.equal(selectCandidates([mk("x", 2.1)], initialPortfolio()).wakeLLM, true);
  const pair = { id: "pair|ETH|BTC", type: "pair", long: { coin: "ETH" }, short: { coin: "BTC" }, score: 5 };
  assert.equal(selectCandidates([pair], { ...initialPortfolio(), positions: [{ venue: "hl", coin: "BTC", side: "short" }] }).candidates.length, 0);
});

const series = (n, f) => Array.from({ length: n }, (_, i) => [NOW - (n - i) * DAY, f(i)]);
const wiggle = (i) => 100 * Math.exp(0.02 * Math.sin(i * 1.7) + 0.001 * i);

test("correlation : identique = 1, opposée = −1, trop courte = null", () => {
  close(correlation(series(40, wiggle), series(40, (i) => wiggle(i) / 2)), 1);
  close(correlation(series(40, wiggle), series(40, (i) => 1e4 / wiggle(i))), -1);
  assert.equal(correlation(series(10, wiggle), series(10, wiggle)), null);
  assert.deepEqual(partnersOf("BTC").includes("ETH"), true);
  assert.deepEqual(partnersOf("FARTCOIN"), []);
});

test("findPairs : baleines longues BTC, neutres ou courtes ETH corrélé → long BTC / short ETH", () => {
  const snap = hlSnap();
  const g = gatherHl(snap, scores, NOW);
  const cand = finalizeHl(g.pass[0], { markets: MK, ohlc: OH }, snap.hl).cand;
  const sent = coinSentiment(g.all);
  close(sent.BTC.s, 1); close(sent.ETH.s, -1);
  const ohlc = { BTC: { ...OH.BTC, closes: series(40, wiggle) }, ETH: { ...OH.ETH, closes: series(40, (i) => wiggle(i) / 2) } };
  const [pair] = findPairs([cand], sent, ohlc, MK);
  assert.equal(pair.id, "pair|BTC|ETH"); close(pair.metrics.rho_30d, 1); close(pair.score, cand.score, 1e-3);
  // ETH porté lui aussi par des baleines longues : pas de paire
  assert.equal(findPairs([cand], { ...sent, ETH: { s: 0.5 } }, ohlc, MK).length, 0);
});

test("décalage Polymarket → Hyperliquid : cote +15 pts en 90 min, BTC immobile → long BTC prioritaire", () => {
  const snapAt = (price) => ({ pm: [{ addr: "w", positions: [{ cid: "m1", outcome: "Yes", price, topic: "BTC", view: 1, title: "Bitcoin above 150k?" }] }] });
  let h = updateHistory(emptyHistory(), snapAt(0.40), { BTC: { mark: 100 } }, NOW - 90 * 60e3);
  h = updateHistory(h, snapAt(0.55), { BTC: { mark: 100.2 } }, NOW);
  assert.equal(h.pm["m1|Yes"].pts.length, 2); assert.equal(h.hl.BTC.length, 2);
  assert.equal(movedMarkets(h, NOW).length, 1);
  const r = detectLeadLag(h, { BTC: { atrPct: 0.04 } }, NOW);
  assert.equal(r.candidates[0].side, "long"); assert.equal(r.candidates[0].score, 3); close(r.candidates[0].metrics.pm_move, 0.15);
  // l'actif a déjà suivi (+2 %) : pas de signal
  const h2 = updateHistory(updateHistory(emptyHistory(), snapAt(0.40), { BTC: { mark: 100 } }, NOW - 90 * 60e3), snapAt(0.55), { BTC: { mark: 102 } }, NOW);
  assert.match(detectLeadLag(h2, { BTC: { atrPct: 0.04 } }, NOW).rejected[0].reason, /déjà réactif/);
  // historique purgé au-delà de 48 h
  assert.equal(Object.keys(updateHistory(h, { pm: [] }, {}, NOW + 49 * H).pm).length, 0);
});
