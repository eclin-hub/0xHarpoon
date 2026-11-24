import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../../lib/paper/config.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";
import { nextMode, riskPerTrade, hlStop, riskState, sizeHl, sizePm, sizePair, killExits, MODES } from "../../lib/paper/risk.mjs";
import { tick } from "../../lib/paper/simulator.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const NOW = Date.UTC(2026, 10, 24, 12);
const DAY = 86400e3;
const base = (over = {}) => ({ ...initialPortfolio(), ...over });
const hlPos = (id, coin, side, size, mark, pocket = "core", factor) => ({ id, venue: "hl", pocket, coin, side, size, mark, entryPx: mark, factor, stopPx: null, fees: 0, entryFee: 0, funding: 0, realized: 0, lastFundingAt: new Date(NOW).toISOString() });
const pmPos = (id, cid, cost, value, pocket = "portage") => ({ id, venue: "pm", pocket, token: "t" + id, cid, shares: value, cost, value, mark: 1, entryPx: cost / value, realized: 0 });

test("nextMode : paliers 10 / 20 / 25 %, retour possible sauf après l'arrêt d'urgence", () => {
  assert.equal(nextMode("normal", 0.05), MODES.normal);
  assert.equal(nextMode("normal", 0.10), MODES.halveR);
  assert.equal(nextMode("normal", 0.20), MODES.reduceOnly);
  assert.equal(nextMode("normal", 0.25), MODES.killed);
  assert.equal(nextMode("halveR", 0.05), MODES.normal);
  assert.equal(nextMode("killed", 0), MODES.killed);
});

test("riskPerTrade : 1 % à 60 de conviction, 1,5 % à 100, divisé par 2, nul si interdit", () => {
  close(riskPerTrade(60, "normal"), 0.01);
  close(riskPerTrade(80, "normal"), 0.0125);
  close(riskPerTrade(100, "normal"), 0.015);
  close(riskPerTrade(150, "normal"), 0.015);   // une conviction aberrante n'augmente pas R
  close(riskPerTrade(100, "halveR"), 0.0075);
  assert.equal(riskPerTrade(59, "normal"), 0);
  assert.equal(riskPerTrade(NaN, "normal"), 0);
  assert.equal(riskPerTrade(100, "reduceOnly"), 0);
  assert.equal(riskPerTrade(100, "killed"), 0);
});

test("hlStop : 2 × ATR / prix, borné entre 3 et 15 %", () => {
  const a = hlStop(100, 2, "long"); close(a.dStop, 0.04); close(a.stopPx, 96);
  close(hlStop(100, 2, "short").stopPx, 104);
  close(hlStop(100, 0.5, "long").dStop, 0.03);
  close(hlStop(100, 10, "long").dStop, 0.15);
});

test("riskState : levier brut, facteurs nets, occupation des poches", () => {
  const s = riskState(base({ positions: [hlPos("a", "BTC", "long", 10, 100), hlPos("b", "ETH", "short", 20, 50), pmPos("c", "0xc", 200, 250)] }));
  close(s.gross, 2250); close(s.factors.CRYPTO_BETA, 0);
  close(s.pockets.core, 2000 / 3); close(s.pockets.portage, 200); close(s.markets["0xc"], 200);
});

test("sizeHl : taille = R × E / stop, puis plafonds", () => {
  const r = sizeHl(base(), { coin: "BTC", side: "long", conviction: 100, price: 100, atr: 2 });
  assert.equal(r.ok, true);
  close(r.order.usd, 3750); close(r.order.riskUsd, 150); close(r.order.stopPx, 96); assert.equal(r.order.binding, "risque R");
  // stop plus serré → taille plus grosse, arrêtée par le plafond de facteur (40 % de 10 000 $)
  const f = sizeHl(base(), { coin: "BTC", side: "long", conviction: 100, price: 100, atr: 0.5 });
  close(f.order.usd, 4000); assert.equal(f.order.binding, "facteur CRYPTO_BETA");
  // facteur déjà chargé dans le même sens / en sens inverse
  const held = base({ positions: [hlPos("a", "ETH", "long", 30, 100)] });
  close(sizeHl(held, { coin: "BTC", side: "long", conviction: 100, price: 100, atr: 2 }).order.usd, 1000);
  close(sizeHl(held, { coin: "BTC", side: "short", conviction: 100, price: 100, atr: 2 }).order.usd, 3750);
  // levier brut global
  const tight = { ...CONFIG, risk: { ...CONFIG.risk, maxGrossLeverage: 0.3 } };
  const g = sizeHl(base(), { coin: "xyz:GOLD", side: "long", conviction: 100, price: 100, atr: 2 }, tight);
  close(g.order.usd, 3000); assert.equal(g.order.binding, "levier brut global");
});

test("sizeHl : freins de drawdown et refus", () => {
  const half = sizeHl(base({ equity: 9000, peakEquity: 10000 }), { coin: "BTC", side: "long", conviction: 100, price: 100, atr: 2 });
  assert.equal(half.mode, "halveR"); close(half.order.usd, 0.0075 * 9000 / 0.04);
  assert.match(sizeHl(base({ equity: 7900, peakEquity: 10000 }), { coin: "BTC", side: "long", conviction: 100, price: 100, atr: 2 }).reason, /reduceOnly : aucune ouverture/);
  assert.match(sizeHl(base(), { coin: "BTC", side: "long", conviction: 50, price: 100, atr: 2 }).reason, /conviction 50/);
  assert.match(sizeHl(base(), { coin: "BTC", side: "long", conviction: 90, price: 100 }).reason, /ATR manquant/);
  assert.match(sizeHl(base(), { coin: "BTC", side: "long", conviction: 90, price: 100, atr: 2, pocket: "portage" }).reason, /portage/);
});

test("sizeHl poche border : catalyseur daté, gain/risque ≥ 3, mise par idée", () => {
  const req = { coin: "xyz:CL", side: "long", conviction: 100, price: 100, atr: 2, pocket: "border" };
  assert.match(sizeHl(base(), req).reason, /expiresAt/);
  const exp = new Date(NOW + 3 * DAY).toISOString();
  assert.match(sizeHl(base(), { ...req, expiresAt: exp, targetPx: 110 }).reason, /gain\/risque 2\.50/);
  const ok = sizeHl(base(), { ...req, expiresAt: exp, targetPx: 115 });
  close(ok.order.usd, 300); assert.equal(ok.order.binding, "mise par idée border"); assert.equal(ok.order.expiresAt, exp);
});

test("sizePm : cœur, portage (cote, échéance, plafond par marché), border, cash", () => {
  const core = sizePm(base(), { token: "1", cid: "0xa", conviction: 100, price: 0.4 }, CONFIG, NOW);
  close(core.order.usd, 150); assert.equal(core.order.binding, "risque R");
  const port = { token: "2", cid: "0xb", pocket: "portage", conviction: 100, price: 0.9, end: new Date(NOW + 5 * DAY).toISOString() };
  close(sizePm(base(), port, CONFIG, NOW).order.usd, 500);
  const already = sizePm(base({ positions: [pmPos("x", "0xb", 400, 440)] }), port, CONFIG, NOW);
  close(already.order.usd, 100); assert.equal(already.order.binding, "plafond par marché");
  assert.match(sizePm(base(), { ...port, price: 0.97 }, CONFIG, NOW).reason, /hors/);
  assert.match(sizePm(base(), { ...port, end: new Date(NOW + 20 * DAY).toISOString() }, CONFIG, NOW).reason, /20\.0 j/);
  assert.match(sizePm(base(), { ...port, end: null }, CONFIG, NOW).reason, /inconnue/);
  const border = { token: "3", pocket: "border", conviction: 100, price: 0.2, expiresAt: new Date(NOW + DAY).toISOString() };
  close(sizePm(base(), border, CONFIG, NOW).order.usd, 300);
  assert.match(sizePm(base(), { ...border, price: 0.3 }, CONFIG, NOW).reason, /gain\/risque/);
  assert.match(sizePm(base(), { ...border, expiresAt: null }, CONFIG, NOW).reason, /expiresAt/);
  const poor = sizePm(base({ cash: 100 }), { token: "1", conviction: 100, price: 0.4 }, CONFIG, NOW);
  close(poor.order.usd, 100); assert.equal(poor.order.binding, "cash disponible");
  assert.match(sizePm(base({ cash: 10 }), { token: "1", conviction: 100, price: 0.4 }, CONFIG, NOW).reason, /minimum/);
});

test("sizePair : même notionnel sur les deux jambes, risque total R", () => {
  const r = sizePair(base(), { long: { coin: "BTC", price: 100, atr: 2 }, short: { coin: "ETH", price: 50, atr: 1 }, conviction: 100 });
  assert.equal(r.orders.length, 2);
  close(r.orders[0].usd, 1875); close(r.orders[1].usd, 1875); close(r.riskUsd, 150);
  assert.deepEqual(r.orders.map((o) => o.side), ["long", "short"]);
  close(r.orders[1].stopPx, 52);
  assert.match(sizePair(base(), { long: { coin: "BTC", price: 1, atr: 1 }, short: { coin: "BTC", price: 1, atr: 1 }, conviction: 100 }).reason, /seul actif/);
});

const BOOK = { bids: [[100, 100]], asks: [[100.1, 100]] };

test("tick : frein à 10 % signalé, arrêt d'urgence à 25 % ferme tout et reste actif", () => {
  const pos = hlPos("hl-1", "BTC", "long", 1, 100);
  const half = tick(base({ peakEquity: 11_500, positions: [pos] }), { markets: { BTC: { mark: 100, funding: 0 } }, hlBooks: { BTC: BOOK } }, NOW);
  assert.equal(half.portfolio.mode, "halveR"); assert.equal(half.modeChange.to, "halveR"); assert.equal(half.portfolio.positions.length, 1);

  const k = tick(base({ peakEquity: 14_000, positions: [pos] }), { markets: { BTC: { mark: 100, funding: 0 } }, hlBooks: { BTC: BOOK } }, NOW);
  assert.equal(k.portfolio.mode, "killed");
  assert.deepEqual(k.trades.map((t) => t.type + ":" + (t.reason || t.to)), ["mode:killed", "close:kill"]);
  assert.equal(k.portfolio.positions.length, 0);
  assert.equal(k.point.mode, "killed");
  const after = tick({ ...k.portfolio, peakEquity: k.portfolio.equity }, {}, NOW + 3600e3);
  assert.equal(after.portfolio.mode, "killed"); assert.equal(after.modeChange, null);
  assert.match(sizeHl(after.portfolio, { coin: "BTC", side: "long", conviction: 100, price: 100, atr: 2 }).reason, /killed/);
  assert.deepEqual(killExits(base({ positions: [pos] })), [{ id: "hl-1", reason: "kill" }]);
});
