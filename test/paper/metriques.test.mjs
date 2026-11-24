import { test } from "node:test";
import assert from "node:assert/strict";
import { dailySeries, returnsOf, sharpe, sortino, maxDrawdown, annualized, normCdf, psr, tradeStats, brier, benchmarks, summarize } from "../../lib/paper/metrics.mjs";
import { emptyShadow, addShadows, updateShadows, modelStats, hlR } from "../../lib/paper/shadow.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const T0 = Date.UTC(2026, 10, 24, 0);
const H = 3600e3, DAY = 86400e3;
const iso = (t) => new Date(t).toISOString();

test("dailySeries : dernier point de chaque jour UTC ; rendements", () => {
  const pts = [{ at: iso(T0 + H), equity: 100 }, { at: iso(T0 + 20 * H), equity: 102 }, { at: iso(T0 + DAY + H), equity: 99 }, { at: iso(T0 + 2 * DAY), equity: 110 }];
  assert.deepEqual(dailySeries(pts).map(([, v]) => v), [102, 99, 110]);
  const r = returnsOf(dailySeries(pts));
  close(r[0], 99 / 102 - 1); close(r[1], 110 / 99 - 1);
});

test("Sharpe, Sortino : formules sur trois rendements", () => {
  const r = [0.01, -0.01, 0.02], m = 0.02 / 3;
  const sd = Math.sqrt(((0.01 - m) ** 2 + (-0.01 - m) ** 2 + (0.02 - m) ** 2) / 2);
  close(sharpe(r), (m / sd) * Math.sqrt(365));
  close(sortino(r), (m / Math.sqrt(0.0001 / 3)) * Math.sqrt(365));
  assert.equal(sharpe([0.01]), null); assert.equal(sharpe([0.01, 0.01]), null);   // écart-type nul
  assert.equal(sortino([0.01, 0.02]), null);                                     // aucune baisse
});

test("drawdown max, rendement annualisé (pas sous 7 jours)", () => {
  close(maxDrawdown([100, 120, 90, 130, 117]), 0.25);
  assert.equal(maxDrawdown([]), 0);
  close(annualized(100, 110, 365), 0.1);
  close(annualized(100, 121, 730), 0.1);
  assert.equal(annualized(100, 101, 0.5), null);
});

test("normCdf et PSR", () => {
  close(normCdf(0), 0.5, 1e-7); close(normCdf(1.96), 0.975, 1e-4); close(normCdf(-1.96), 0.025, 1e-4);
  assert.equal(psr([0.01, 0.01, 0.01]), null);
  const good = Array.from({ length: 200 }, (_, i) => 0.002 + (i % 2 ? 0.01 : -0.01));
  assert.ok(psr(good) > 0.99);
  const flat = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.01 : -0.01));
  close(psr(flat), 0.5, 1e-6);
});

test("tradeStats : seules les fermetures complètes et les résolutions comptent", () => {
  const t = [{ type: "close", net: 100, pocket: "core" }, { type: "close", net: -50, pocket: "core" }, { type: "settle", net: 30, pocket: "portage" },
    { type: "close", net: -20, pocket: "core" }, { type: "reduce", pnl: 999 }, { type: "open" }, { type: "mode" }];
  const s = tradeStats(t);
  assert.equal(s.closed, 4); close(s.winRate, 0.5); close(s.expectancyUsd, 15); close(s.profitFactor, 130 / 70);
  assert.equal(s.byPocket.portage.netUsd, 30);
  assert.equal(tradeStats([{ type: "close", net: 5 }]).profitFactor, null);
});

test("Brier : conviction de l'agent contre prix payé, marchés résolus seulement", () => {
  const b = brier([{ type: "settle", conviction: 80, won: true, entryPx: 0.6 }, { type: "settle", conviction: 70, won: false, entryPx: 0.3 }, { type: "close", conviction: 90 }]);
  assert.equal(b.n, 2);
  close(b.agent, (0.04 + 0.49) / 2); close(b.market, (0.16 + 0.09) / 2); close(b.skill, 0.125 - 0.265);
  assert.equal(brier([]).agent, null);
});

test("références passives : BTC seul et 50/50 BTC-or sans rééquilibrage", () => {
  const pts = [{ at: iso(T0), equity: 1e4 }, { at: iso(T0 + H), equity: 1e4, bench: { BTC: 100, GOLD: 10 } }, { at: iso(T0 + DAY), equity: 1e4, bench: { BTC: 110, GOLD: 9 } }];
  const b = benchmarks(pts, 1e4);
  assert.equal(b.since, iso(T0 + H)); close(b.btc.totalReturn, 0.1); close(b.btcGold.totalReturn, 0);
  assert.equal(benchmarks([{ at: iso(T0), equity: 1 }], 1e4), null);
});

test("summarize : synthèse complète, significativité à 30 trades", () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ at: iso(T0 + i * DAY), equity: 1e4 * (1 + 0.01 * i), bench: { BTC: 100 + i, GOLD: 10 } }));
  const s = summarize({ points: pts, trades: Array.from({ length: 30 }, () => ({ type: "close", net: 1 })), startCapital: 1e4 });
  close(s.totalReturn, 0.09); assert.equal(s.dailyReturns, 9); assert.equal(s.significant, true);
  assert.ok(s.performance.sharpe > 0); assert.equal(s.performance.calmar, null);   // aucun drawdown
  close(s.days, 9); assert.ok(s.performance.annualizedReturn > 0);
  assert.equal(summarize({}).equity, 10_000);
});

/* ---------- PnL contrefactuel ---------- */

const NOW = T0 + 12 * H;
const C_HL = { id: "hl|BTC|long", type: "whale", venue: "hl", coin: "BTC", side: "long", metrics: { mark: 100, atr14: 2 } };
const C_SHORT = { id: "leadlag|m|Yes", type: "leadlag", venue: "hl", coin: "ETH", side: "short", metrics: { mark: 50, atr_pct: 0.04 } };
const C_PAIR = { id: "pair|BTC|ETH", type: "pair", venue: "hl", long: { coin: "BTC" }, short: { coin: "ETH" }, metrics: { long_leg: { coin: "BTC", mark: 100, atr14: 2 }, short_leg: { coin: "ETH", mark: 50, atr14: 1 } } };
const C_PM = { id: "pm|c1|Yes", type: "whale", venue: "pm", cid: "c1", token: "t1", outcome: "Yes", metrics: { price: 0.4 } };
const dossier = { candidates: [C_HL, C_SHORT, C_PAIR, C_PM] };
const v = (model, id, action = "OPEN", valid = true, h = 72) => ({ model, family: model, candidate_id: id, action, valid, conviction: 75, horizon_hours: h });

test("addShadows : un vote OPEN valide = une position fantôme, sans doublon", () => {
  const a = addShadows(emptyShadow(), [v("m1", C_HL.id), v("m1", C_PM.id), v("m2", C_HL.id, "REJECT"), v("m3", C_HL.id, "OPEN", false), v("m1", "inconnu")], dossier, NOW);
  assert.equal(a.added.length, 2); close(a.book.open[0].legs[0].d, 0.04); assert.equal(a.book.open[1].p0, 0.4);
  assert.equal(addShadows(a.book, [v("m1", C_HL.id)], dossier, NOW + H).added.length, 0);
  close(addShadows(emptyShadow(), [v("m1", C_SHORT.id)], dossier, NOW).book.open[0].legs[0].d, 0.08);   // ATR = 4 % × 50 = 2, stop = 2 × 2 / 50
});

test("updateShadows : stop à −1 R, horizon, short, paire", () => {
  const b = addShadows(emptyShadow(), [v("m1", C_HL.id), v("m2", C_SHORT.id), v("m3", C_PAIR.id)], dossier, NOW).book;
  const still = updateShadows(b, { markets: { BTC: { mark: 102 }, ETH: { mark: 49 } } }, NOW + H);
  assert.equal(still.closed.length, 0);
  close(hlR(still.book.open[0], { BTC: { mark: 102 } }), 0.5);
  close(hlR(still.book.open[1], { ETH: { mark: 49 } }), 0.02 / 0.08);
  close(hlR(still.book.open[2], { BTC: { mark: 102 }, ETH: { mark: 49 } }), (0.02 + 0.02) / 0.08);
  const stop = updateShadows(b, { markets: { BTC: { mark: 95 }, ETH: { mark: 50 } } }, NOW + H);
  assert.deepEqual(stop.closed.map((c) => [c.model, c.R, c.exit]), [["m1", -1, "stop"]]);
  const end = updateShadows(b, { markets: { BTC: { mark: 102 }, ETH: { mark: 49 } } }, NOW + 72 * H);
  assert.deepEqual(end.closed.map((c) => c.R), [0.5, 0.25, 0.5]); assert.equal(end.book.open.length, 0);
});

test("updateShadows Polymarket : résolution, horizon au dernier prix, sinon attente", () => {
  const b = addShadows(emptyShadow(), [v("m1", C_PM.id)], dossier, NOW).book;
  close(updateShadows(b, { resolutions: { c1: { resolved: true, winner: { token: "t1" } } } }, NOW + H).closed[0].R, 1.5);
  close(updateShadows(b, { resolutions: { c1: { resolved: true, winner: { token: "t2" } } } }, NOW + H).closed[0].R, -1);
  close(updateShadows(b, { pmPrices: { "c1|Yes": 0.5 } }, NOW + 72 * H).closed[0].R, 0.25);
  assert.equal(updateShadows(b, {}, NOW + 72 * H).book.open.length, 1);
});

test("modelStats : R cumulé, taux de réussite, équivalent en dollars (1 R = 1 % de 10 000 $)", () => {
  const book = { open: [], closed: [{ model: "m1", family: "a", R: 1.5 }, { model: "m1", family: "a", R: -1 }, { model: "m2", family: "b", R: -1 }] };
  const s = modelStats(book);
  assert.deepEqual(s.map((x) => [x.model, x.sumR, x.winRate, x.pnlUsd]), [["m1", 0.5, 0.5, 50], ["m2", -1, 0, -100]]);
});
