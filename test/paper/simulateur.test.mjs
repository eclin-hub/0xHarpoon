import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../../lib/paper/config.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";
import { walkBook, openHl, closeHl, applyFunding, openPm, closePm, settlePm, markToMarket, dueExits, tick, mid } from "../../lib/paper/simulator.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const T0 = Date.UTC(2026, 10, 24, 10, 30);   // 24/11/2026 10:30 UTC
const H = 3600e3;
const BTC = { asks: [[100, 1], [101, 1], [102, 10]], bids: [[99, 1], [98, 1], [97, 10]] };
const wide = { ...CONFIG, exec: { ...CONFIG.exec, hlMaxSlippage: 0.05 } };
const fresh = () => initialPortfolio(new Date(T0).toISOString());
const FEE = CONFIG.exec.hlTakerFee;

test("walkBook : montant ou quantité, limite de prix respectée", () => {
  const b = walkBook(BTC.asks, { usd: 150 });
  close(b.usd, 150); close(b.qty, 1 + 50 / 101); assert.equal(b.levels, 2); assert.equal(b.best, 100);
  const s = walkBook(BTC.bids, { qty: 1.5 }, null, "sell");
  close(s.usd, 99 + 49); close(s.avgPx, 148 / 1.5);
  const lim = walkBook(BTC.asks, { usd: 1000 }, 100.5);
  close(lim.usd, 100); assert.equal(lim.levels, 1);
  assert.equal(walkBook([], { usd: 10 }).qty, 0);
});

test("openHl : remplissage sur plusieurs niveaux, frais, portefeuille d'origine intact", () => {
  const p0 = fresh();
  const r = openHl(p0, { coin: "BTC", side: "long", usd: 150, stopPx: 95, candidateId: "c1" }, BTC, T0, wide);
  assert.equal(r.rejected, null);
  const pos = r.portfolio.positions[0];
  close(pos.size, 1 + 50 / 101); close(pos.entryPx, 150 / (1 + 50 / 101)); close(pos.fees, 150 * FEE);
  close(r.portfolio.cash, 10_000 - 150 * FEE);
  assert.equal(pos.factor, "CRYPTO_BETA"); assert.equal(pos.id, "hl-1"); assert.equal(r.trade.partial, false);
  assert.equal(p0.positions.length, 0); assert.equal(p0.cash, 10_000);
});

test("openHl : limite de glissement → partiel, ou rejet sous 50 %", () => {
  const part = openHl(fresh(), { coin: "BTC", side: "long", usd: 150 }, BTC, T0);
  close(part.trade.usd, 100); assert.equal(part.trade.partial, true);
  const rej = openHl(fresh(), { coin: "BTC", side: "long", usd: 300 }, BTC, T0);
  assert.match(rej.rejected.reason, /liquidité insuffisante/);
  assert.match(openHl(fresh(), { coin: "BTC", side: "long", usd: 50 }, { asks: [], bids: [] }, T0).rejected.reason, /carnet vide/);
  assert.match(openHl(fresh(), { coin: "BTC", side: "flat", usd: 50 }, BTC, T0).rejected.reason, /invalide/);
});

test("aller-retour immédiat : on perd exactement l'écart et les deux frais", () => {
  const o = openHl(fresh(), { coin: "BTC", side: "long", usd: 100 }, BTC, T0);
  const c = closeHl(o.portfolio, "hl-1", BTC, { reason: "manual" }, T0 + 1000);
  assert.equal(c.trade.type, "close"); assert.equal(c.portfolio.positions.length, 0);
  close(c.portfolio.cash, 10_000 - 1 - 100 * FEE - 99 * FEE);
  close(c.trade.net, -1 - 100 * FEE - 99 * FEE);
});

test("markToMarket : PnL latent long, sommet et drawdown", () => {
  const o = openHl(fresh(), { coin: "BTC", side: "long", usd: 100 }, BTC, T0);
  const up = markToMarket(o.portfolio, { markets: { BTC: { mark: 110 } } }, T0);
  close(up.portfolio.equity, 10_000 - 100 * FEE + 10); close(up.portfolio.peakEquity, up.portfolio.equity); close(up.portfolio.drawdown, 0);
  const down = markToMarket(up.portfolio, { markets: { BTC: { mark: 90 } } }, T0 + H);
  close(down.portfolio.equity, 10_000 - 100 * FEE - 10);
  close(down.portfolio.drawdown, 1 - down.portfolio.equity / up.portfolio.equity);
  assert.equal(down.point.positions, 1);
  // sans prix frais : on garde le dernier mark connu
  close(markToMarket(down.portfolio, {}, T0 + 2 * H).portfolio.equity, down.portfolio.equity);
});

test("applyFunding : une fois par heure pleine franchie, long paie, short reçoit", () => {
  const mk = { BTC: { mark: 100, funding: 0.0001 } };
  const lo = openHl(fresh(), { coin: "BTC", side: "long", usd: 100 }, BTC, T0).portfolio;
  assert.equal(applyFunding(lo, mk, T0 + 20 * 60e3).payments.length, 0);          // 10:50, même heure
  const f = applyFunding(lo, mk, Date.UTC(2026, 10, 24, 13, 5));                    // 3 heures pleines
  assert.equal(f.payments[0].hours, 3); close(f.payments[0].paid, 0.03);
  close(f.portfolio.cash, lo.cash - 0.03); close(f.portfolio.positions[0].funding, -0.03);
  assert.equal(applyFunding(f.portfolio, mk, Date.UTC(2026, 10, 24, 13, 40)).payments.length, 0);   // pas de double paiement
  const sh = openHl(fresh(), { coin: "BTC", side: "short", usd: 99 }, BTC, T0).portfolio;
  close(applyFunding(sh, mk, T0 + H).portfolio.cash, sh.cash + 1 * 100 * 0.0001);
});

test("stop short touché : fermeture forcée, carnet trop mince complété au prix dégradé", () => {
  const sh = openHl(fresh(), { coin: "BTC", side: "short", usd: 99, stopPx: 105 }, BTC, T0).portfolio;
  assert.deepEqual(dueExits(sh, { BTC: { mark: 104 } }, T0), []);
  const t = tick(sh, { markets: { BTC: { mark: 106, funding: 0 } }, hlBooks: { BTC: { asks: [[106, 0.4]], bids: [] } } }, T0 + 60e3);
  assert.equal(t.trades.length, 1);
  const tr = t.trades[0];
  assert.equal(tr.reason, "stop"); close(tr.synthetic, 0.6);
  const usd = 0.4 * 106 + 0.6 * 106 * 1.005;
  close(tr.usd, usd); close(tr.pnl, -(usd - 99) - usd * FEE);
  assert.equal(t.portfolio.positions.length, 0);
  close(t.portfolio.cash, 10_000 - 99 * FEE - (usd - 99) - usd * FEE);
  close(t.portfolio.equity, t.portfolio.cash);
  close(t.point.equity, t.portfolio.cash, 0.005);   // la courbe est arrondie au centime
});

test("stop long sans carnet : fermé au mark dégradé, jamais ignoré", () => {
  const lo = openHl(fresh(), { coin: "BTC", side: "long", usd: 100, stopPx: 95 }, BTC, T0).portfolio;
  const t = tick(lo, { markets: { BTC: { mark: 94, funding: 0 } } }, T0 + 60e3);
  close(t.trades[0].px, 94 * (1 - CONFIG.exec.hlMaxSlippage));
  assert.deepEqual(t.problems, []);
});

const PM = { asks: [[0.40, 100], [0.41, 100], [0.50, 1000]], bids: [[0.38, 50], [0.30, 1000]] };
const pmReq = { token: "777", cid: "0xc", outcome: "Yes", title: "Test", usd: 60 };

test("openPm : achat dans la limite, cash débité, valorisé au milieu du carnet", () => {
  const r = openPm(fresh(), pmReq, PM, T0);
  const pos = r.portfolio.positions[0];
  close(pos.shares, 100 + 20 / 0.41); close(pos.cost, 60); close(r.portfolio.cash, 9_940);
  assert.equal(mid(PM), 0.39);
  close(markToMarket(r.portfolio, { pmBooks: { 777: PM } }, T0).portfolio.equity, 9_940 + pos.shares * 0.39);
  assert.match(openPm({ ...fresh(), cash: 50 }, pmReq, PM, T0).rejected.reason, /cash insuffisant/);
});

test("settlePm : 1 $ par part gagnante, 0 $ sinon, rien tant que non résolu", () => {
  const p = openPm(fresh(), pmReq, PM, T0).portfolio, shares = p.positions[0].shares;
  const res = (win) => ({ resolved: true, winner: { token: win, outcome: "?" } });
  const won = settlePm(p, "pm-1", res("777"), T0);
  close(won.portfolio.cash, 9_940 + shares); close(won.trade.pnl, shares - 60); assert.equal(won.trade.won, true);
  const lost = settlePm(p, "pm-1", res("888"), T0);
  close(lost.portfolio.cash, 9_940); close(lost.trade.pnl, -60); assert.equal(lost.portfolio.positions.length, 0);
  assert.equal(settlePm(p, "pm-1", { resolved: false }, T0).trade, null);
  const viaTick = tick(p, { resolutions: { "0xc": res("777") } }, T0);
  assert.equal(viaTick.trades[0].type, "settle");
});

test("closePm : vente partielle dans la limite, forcée = tout le carnet", () => {
  const p = openPm(fresh(), pmReq, PM, T0).portfolio, shares = p.positions[0].shares;
  const part = closePm(p, "pm-1", PM, { reason: "invalidation" }, T0);
  assert.equal(part.trade.type, "reduce"); close(part.trade.qty, 50); close(part.trade.pnl, 19 - 60 * 50 / shares);
  close(part.portfolio.positions[0].shares, shares - 50); close(part.portfolio.positions[0].cost, 60 * (1 - 50 / shares));
  const all = closePm(p, "pm-1", PM, { reason: "kill", forced: true }, T0);
  assert.equal(all.trade.type, "close"); close(all.portfolio.cash, 9_940 + 19 + (shares - 50) * 0.30);
  assert.match(closePm(p, "pm-1", { bids: [] }, {}, T0).rejected.reason, /aucun acheteur/);
});

test("échéance dépassée (poche border) : sortie forcée au tick suivant", () => {
  const p = openPm(fresh(), { ...pmReq, pocket: "border", expiresAt: new Date(T0 + H).toISOString() }, PM, T0).portfolio;
  assert.equal(tick(p, { pmBooks: { 777: PM } }, T0 + H - 1).trades.length, 0);
  const t = tick(p, { pmBooks: { 777: PM } }, T0 + H);
  assert.equal(t.trades[0].reason, "expiry"); assert.equal(t.portfolio.positions.length, 0);
  const noBook = tick(p, {}, T0 + H);
  assert.match(noBook.problems[0], /expiry pm-1 non exécuté/);
  assert.equal(noBook.portfolio.positions.length, 1);
});
