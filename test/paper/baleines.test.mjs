import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../../lib/paper/config.mjs";
import { categoryOfHl, categoryOfPm, scoreHlClose, scorePmClose, emptyScores, applyOutcome, updateScores, setPriors, priorsFromHl, priorsFromPm, weightOf, keyOf } from "../../lib/paper/scorer.mjs";
import { fetchPriorSources } from "../../lib/paper/loader.mjs";
import { diffWhales } from "../../lib/pm.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const T0 = Date.UTC(2026, 10, 24);
const DAY = 86400e3;

test("catégories Hyperliquid et Polymarket", () => {
  assert.deepEqual(["BTC", "FARTCOIN", "xyz:CL", "xyz:SP500", "PAXG", "xyz:DXY"].map(categoryOfHl), ["crypto", "crypto", "commodities", "commodities", "commodities", "macro"]);
  assert.equal(categoryOfHl(null), null);
  assert.equal(categoryOfPm({ title: "Will Bitcoin reach $150k?", category: "crypto" }), "crypto");
  assert.equal(categoryOfPm({ title: "Fed rate cut in December?", category: "finance" }), "macro");
  assert.equal(categoryOfPm({ title: "Will crude oil hit $100?", category: "finance" }), "commodities");
  assert.equal(categoryOfPm({ title: "Iran ceasefire by March?", category: "politics" }), "geopolitics");
  assert.equal(categoryOfPm({ title: "Lakers vs Celtics", category: "sports" }), null);
});

test("score d'une fermeture Hyperliquid : tanh(PnL / notionnel / 5 %)", () => {
  close(scoreHlClose({ upnl: 5_000, notional: 100_000 }), Math.tanh(1));
  close(scoreHlClose({ upnl: -50_000, notional: 100_000 }), Math.tanh(-10));
  assert.equal(scoreHlClose({ notional: 100_000 }), null);
});

test("score Polymarket : issue − prix moyen, ou dernier prix − prix moyen si non résolu", () => {
  const win = { resolved: true, winner: { token: "1", outcome: "Yes" } };
  close(scorePmClose({ avg: 0.2, outcome: "Yes" }, win), 0.8);     // longshot gagnant : gros score
  close(scorePmClose({ avg: 0.95, outcome: "Yes" }, win), 0.05);   // favori gagnant : petit score
  close(scorePmClose({ avg: 0.9, outcome: "No" }, win), -0.9);
  close(scorePmClose({ avg: 0.3, token: "1" }, win), 0.7);         // sans libellé : comparaison par jeton
  close(scorePmClose({ avg: 0.5, price: 0.6 }, null), 0.1);
  assert.equal(scorePmClose({ price: 0.6 }, null), null);
});

test("applyOutcome : moyenne mobile, bornes 0,5 à 2, creux cumulé", () => {
  let c = applyOutcome(null, 0.8, T0);
  close(c.w, 0.8 + 0.2 * 1.8); assert.equal(c.n, 1);
  c = applyOutcome(c, -1, T0 + 1);
  close(c.w, 0.8 * 1.16); close(c.cum, -0.2); close(c.maxDD, 1);
  let up = null, down = null;
  for (let i = 0; i < 100; i++) { up = applyOutcome(up, 1, T0); down = applyOutcome(down, -1, T0); }
  assert.ok(up.w <= 2 && up.w > 1.99); assert.equal(down.w, 0.5);
});

test("updateScores : curseur, pas de double comptage, hors catégorie ignoré", () => {
  const events = [
    { t: T0 + 3, src: "hl", kind: "close", addr: "0xA", coin: "BTC", upnl: 5_000, notional: 100_000 },
    { t: T0 + 2, src: "pm", kind: "close", addr: "0xB", title: "Fed rate cut?", category: "finance", outcome: "Yes", avg: 0.4, cid: "0xc" },
    { t: T0 + 1, src: "pm", kind: "close", addr: "0xC", title: "Lakers vs Celtics", category: "sports", avg: 0.5, price: 0.9 },
    { t: T0 + 4, src: "hl", kind: "open", addr: "0xA", coin: "ETH" },
  ];
  const r = updateScores(emptyScores(T0), events, { resolutions: { "0xc": { resolved: true, winner: { token: "9", outcome: "Yes" } } } });
  assert.equal(r.applied.length, 2); assert.equal(r.skipped.length, 1); assert.equal(r.scores.cursor, T0 + 4);
  close(r.scores.whales[keyOf("pm", "0xB")].cats.macro.w, 0.8 + 0.2 * 1.6);
  assert.equal(r.scores.whales[keyOf("hl", "0xa")].cats.crypto.n, 1);   // adresse normalisée en minuscules
  const again = updateScores(r.scores, events);
  assert.equal(again.applied.length, 0);
});

test("poids de départ : ROI Hyperliquid, rang Polymarket, bornés à 0,75 – 1,25", () => {
  const hl = priorsFromHl([{ addr: "0xA", month: { roi: 0.25 } }, { addr: "0xB", month: { roi: 2 } }, { addr: "0xC", month: { roi: -1 } }]);
  close(hl[keyOf("hl", "0xa")].crypto, 1.125); close(hl[keyOf("hl", "0xb")].macro, 1.25); close(hl[keyOf("hl", "0xc")].geopolitics, 0.75);
  const pm = priorsFromPm({ CRYPTO: [{ addr: "1" }, { addr: "2" }, { addr: "3" }], FINANCE: [{ addr: "1" }] });
  close(pm[keyOf("pm", "1")].crypto, 1.25); close(pm[keyOf("pm", "2")].crypto, 1); close(pm[keyOf("pm", "3")].crypto, 0.75);
  close(pm[keyOf("pm", "1")].macro, 1); close(pm[keyOf("pm", "1")].commodities, 1);   // seul du classement : neutre
});

test("weightOf : démarrage, filtre N ≥ 15 après la phase de démarrage, creux excessif", () => {
  let s = setPriors(emptyScores(T0), { [keyOf("hl", "0xa")]: { crypto: 1.2 }, [keyOf("hl", "0xb")]: { crypto: 1.6 } });
  assert.deepEqual(weightOf(s, "hl", "0xA", "crypto", T0 + DAY), { w: 1.2, n: 0, warmup: true, eligible: true, reason: null });
  close(weightOf(s, "hl", "0xB", "crypto", T0 + DAY).w, 1.25);
  const later = T0 + (CONFIG.whales.warmupDays + 1) * DAY;
  assert.match(weightOf(s, "hl", "0xA", "crypto", later).reason, /0 positions résolues < 15/);
  // 15 gains : poids libre au-dessus de 1,25 et admis après la phase de démarrage
  const wins = Array.from({ length: 15 }, (_, i) => ({ t: T0 + i + 1, src: "hl", kind: "close", addr: "0xA", coin: "BTC", upnl: 10_000, notional: 100_000 }));
  s = updateScores(s, wins).scores;
  const w = weightOf(s, "hl", "0xA", "crypto", later);
  assert.equal(w.eligible, true); assert.equal(w.n, 15); assert.ok(w.w > 1.25);
  // 5 pertes franches : creux cumulé > 4 → exclue, même en phase de démarrage
  const losses = Array.from({ length: 5 }, (_, i) => ({ t: T0 + 100 + i, src: "hl", kind: "close", addr: "0xC", coin: "ETH", upnl: -50_000, notional: 100_000 }));
  s = updateScores(s, losses).scores;
  assert.match(weightOf(s, "hl", "0xC", "crypto", T0 + DAY).reason, /creux cumulé/);
  // une catégorie déjà notée garde son historique quand les poids de départ sont rafraîchis
  assert.equal(setPriors(s, { [keyOf("hl", "0xa")]: { crypto: 0.8 } }).whales[keyOf("hl", "0xa")].cats.crypto.n, 15);
});

test("fetchPriorSources : un classement en échec n'empêche pas les autres", async () => {
  const r = await fetchPriorSources({ fetchLeaderboard: async () => [{ addr: "0xA" }], pmLeaderboard: async (_, c) => { if (c === "CRYPTO") throw new Error("HTTP 429"); return [{ addr: c }]; } });
  assert.equal(r.hlRows.length, 1); assert.deepEqual(Object.keys(r.pmBoards), ["POLITICS", "FINANCE"]); assert.match(r.errors[0], /CRYPTO/);
});

test("pm.diffWhales : les événements portent cid, jeton et prix moyen", () => {
  const pos = { title: "X?", outcome: "Yes", price: 0.5, avg: 0.42, value: 20_000, cost: 16_800, cid: "0xc", token: "77" };
  const ev = diffWhales([{ addr: "w", positions: [pos] }], [{ addr: "w", positions: [] }]);
  assert.equal(ev[0].kind, "close"); assert.equal(ev[0].cid, "0xc"); assert.equal(ev[0].token, "77"); assert.equal(ev[0].avg, 0.42);
});
