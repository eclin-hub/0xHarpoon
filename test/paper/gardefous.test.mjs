// Garde-fous issus de l'audit des 3 premiers jours : modèles « ombre », délai de sortie par vote, ré-entrée,
// panier corrélé, barrières Polymarket trop éloignées du prix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LLMRouter, DEFAULT_PROVIDERS } from "../../lib/paper/router.mjs";
import { decide } from "../../lib/paper/decision.mjs";
import { executeDecisions } from "../../lib/paper/execute.mjs";
import { addShadows } from "../../lib/paper/shadow.mjs";
import { voteCloseCheck, reentryCheck, correlatedCheck, parseBarrier, barrierCheck } from "../../lib/paper/risk.mjs";
import { detectLeadLag } from "../../lib/paper/cross.mjs";
import { withSignalOdds } from "../../lib/paper/pminfo.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 10, 27, 10), H = 3600e3;
const vote = (id, action, conviction = 80) => ({ candidate_id: id, action, conviction, invalidation_condition: "retour sous l'entrée", horizon_hours: 48, cited_risk_metric: "dist_atr = 0.55" });
const CAND = { id: "hl|BTC|long", type: "whale", venue: "hl", coin: "BTC", side: "long", pocket: "core", score: 3, metrics: { mark: 100, atr14: 2, dist_atr: 0.55 } };
const dossier = (cands = [CAND]) => ({ wakeLLM: true, candidates: cands, rejected: [] });
const deep = (px, sz = 1e6) => ({ asks: [[px, sz]], bids: [[px * 0.999, sz]] });
const deps = (books) => ({ fetchL2Book: async (c) => books[c], fetchBook: async (t) => books[t] });
const hlPos = (id, coin, side, openedAt = NOW - 24 * H) => ({ id, venue: "hl", pocket: "core", coin, side, size: 1, entryPx: 100, entryUsd: 100, stopPx: side === "long" ? 90 : 110,
  entryFee: 0, fees: 0, funding: 0, realized: 0, mark: 100, upnl: 0, openedAt: new Date(openedAt).toISOString(), lastFundingAt: new Date(openedAt).toISOString() });

test("(a) modèles ombre (shadowOnly) : poids nul dans le consensus, suivis dans le PnL contrefactuel ; aucun dans le socle actuel", async () => {
  assert.deepEqual(DEFAULT_PROVIDERS.flatMap((p) => p.models).filter((m) => m.shadowOnly), []);
  // mécanisme conservé : un modèle marqué shadowOnly vote à part, poids nul
  const providers = [{ name: "p", url: "https://p.test/v1", keyEnv: "K", models: [{ id: "a", family: "a" }, { id: "b", family: "b" }, { id: "s", family: "s", shadowOnly: true }] }];
  const f = async (url, init) => {
    const model = JSON.parse(init.body).model, shadow = model === "s";
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ votes: [vote(CAND.id, shadow ? "OPEN" : "REJECT", shadow ? 95 : 70)] }) } }] }), { status: 200 });
  };
  const router = new LLMRouter({ env: { K: "k" }, providers, fetch: f });
  assert.deepEqual(router.available().map((m) => m.model), ["a", "b"]);
  const d = await decide({ router, dossier: dossier(), portfolio: initialPortfolio(), now: NOW });
  assert.equal(d.mode, "vote");
  assert.deepEqual(d.votes.filter((v) => v.weight > 0).map((v) => [v.model, v.weight]), [["a", 0.5], ["b", 0.5]]);   // poids égaux sans classement
  assert.deepEqual(d.errors, []); assert.deepEqual(d.shadowErrors, []);
  const sh = d.votes.filter((v) => v.weight === 0);
  assert.deepEqual(sh.map((v) => v.model), ["s"]); assert.ok(sh.every((v) => v.action === "OPEN" && v.shadowOnly));
  assert.equal(d.decisions.length, 0); assert.equal(d.records[0].decision, "REJECT"); assert.equal(d.records[0].n, 2);
  assert.deepEqual(addShadows(null, d.votes, dossier(), NOW).book.open.map((s) => s.model), ["s"]);
});
test("(b) sortie par vote refusée à t + 2 h ; acceptée après 8 h ou sur invalidation majeure (≥ 85 %)", async () => {
  const p = { ...initialPortfolio(), positions: [hlPos("hl-1", "BTC", "long", NOW - 2 * H)] };
  const close = { id: "hl-1", action: "CLOSE", via: "2/3 votes", closeShare: 2 / 3, conviction: 75 };
  const r = await executeDecisions(p, [close], dossier([]), { markets: { BTC: { mark: 100 } }, deps: deps({ BTC: deep(100) }), now: NOW });
  assert.equal(r.trades.length, 0); assert.equal(r.portfolio.positions.length, 1);
  assert.match(r.refused[0].reason, /2\.0 h de détention < 8 h/);
  assert.equal(voteCloseCheck(p.positions[0], { closeShare: 1, conviction: 90 }, NOW).override, true);
  assert.equal(voteCloseCheck(p.positions[0], { closeShare: 1, conviction: 80 }, NOW).ok, false);
  const late = await executeDecisions(p, [close], dossier([]), { markets: { BTC: { mark: 100 } }, deps: deps({ BTC: deep(100) }), now: NOW + 7 * H });
  assert.equal(late.trades[0].type, "close");
});

test("(c) 4e SHORT du panier corrélé refusé ; un LONG ou un actif hors panier passe", async () => {
  const p = { ...initialPortfolio(), positions: [hlPos("hl-1", "ETH", "short"), hlPos("hl-2", "SOL", "short"), hlPos("hl-3", "xyz:NVDA", "short")] };
  const short = { ...CAND, id: "hl|HYPE|short", coin: "HYPE", side: "short" };
  const r = await executeDecisions(p, [{ id: short.id, action: "OPEN", via: "unanimité", conviction: 80 }], dossier([short]), { markets: { HYPE: { mark: 100 } }, deps: deps({ HYPE: deep(100) }), now: NOW });
  assert.equal(r.trades.length, 0); assert.match(r.refused[0].reason, /panier corrélé : déjà 3 SHORT/);
  assert.equal(correlatedCheck(p, [{ coin: "BTC", side: "long" }]).ok, true);
  assert.equal(correlatedCheck(p, [{ coin: "xyz:GOLD", side: "short" }]).ok, true);
  assert.equal(correlatedCheck(p, [{ coin: "xyz:SOXL", side: "short" }]).ok, false);
});

test("(d) signal Polymarket à barrière : rejeté à +15 % du prix, accepté à 6 %", async () => {
  assert.equal(parseBarrier("Will Bitcoin reach $61,000 on November 25?"), 61000);
  assert.equal(parseBarrier("Will NVIDIA (NVDA) hit (HIGH) $176 in November?"), 176);
  assert.equal(parseBarrier("Will ETH be above $2.5k on Friday?"), 2500);
  assert.equal(parseBarrier("Fed decision in December?"), null);
  assert.equal(barrierCheck("Will Bitcoin reach $115,000 by Friday?", 100000).ok, false);   // +15 %
  assert.equal(barrierCheck("Will Bitcoin reach $106,000 by Friday?", 100000).ok, true);    // +6 %
  // détection lead-lag : le candidat n'est pas formé
  const hist = (title) => ({ pm: { "0xa|Yes": { coin: "BTC", view: 1, title, cid: "0xa", outcome: "Yes", pts: [[NOW - H, 0.2], [NOW, 0.35]] } }, hl: { BTC: [[NOW - H, 100000], [NOW, 100000]] } });
  const far = detectLeadLag(hist("Will Bitcoin reach $115,000 by Friday?"), { BTC: { atrPct: 0.04 } }, NOW);
  assert.equal(far.candidates.length, 0); assert.match(far.rejected[0].reason, /barrière Polymarket à 15\.0 %/);
  const near = detectLeadLag(hist("Will Bitcoin reach $106,000 by Friday?"), { BTC: { atrPct: 0.04 } }, NOW);
  assert.equal(near.candidates.length, 1); assert.equal(near.candidates[0].metrics.pm_price, 0.35); assert.equal(near.candidates[0].metrics.pm_price_start, 0.2);
  // et à l'exécution, par sécurité
  const ll = { id: "leadlag|0xa|Yes", type: "leadlag", venue: "hl", coin: "BTC", side: "long", pocket: "core", score: 3, metrics: { pm_title: "Will Bitcoin reach $115,000 by Friday?", mark: 100000, atr_pct: 0.04 } };
  const r = await executeDecisions(initialPortfolio(), [{ id: ll.id, action: "OPEN", via: "unanimité", conviction: 80 }], dossier([ll]), { markets: { BTC: { mark: 100000 } }, deps: deps({ BTC: deep(100000) }), now: NOW });
  assert.equal(r.trades.length, 0); assert.match(r.refused[0].reason, /barrière/);
});

test("ré-entrée refusée moins de 4 h après la fermeture du même actif", async () => {
  const exits = { "hl:BTC": new Date(NOW - 3 * H).toISOString() };
  const r = await executeDecisions(initialPortfolio(), [{ id: CAND.id, action: "OPEN", via: "unanimité", conviction: 80 }], dossier(), { markets: { BTC: { mark: 100 } }, deps: deps({ BTC: deep(100) }), now: NOW, exits });
  assert.equal(r.trades.length, 0); assert.match(r.refused[0].reason, /ré-entrée sur BTC refusée : fermé il y a 3\.0 h/);
  assert.equal(reentryCheck(["hl:BTC"], exits, NOW + 2 * H).ok, true);
  // fermeture puis réouverture dans le même cycle : bloquée aussi
  const p = { ...initialPortfolio(), positions: [hlPos("hl-1", "BTC", "short")] };
  const both = await executeDecisions(p, [{ id: "hl-1", action: "CLOSE", via: "3/3 votes" }, { id: CAND.id, action: "OPEN", via: "unanimité", conviction: 80 }], dossier(),
    { markets: { BTC: { mark: 100 } }, deps: deps({ BTC: deep(100) }), now: NOW });
  assert.deepEqual(both.trades.map((t) => t.type), ["close"]); assert.match(both.refused[0].reason, /ré-entrée/);
});

test("cote du signal lead-lag : à l'entrée et maintenant (aucune part Polymarket achetée)", () => {
  const history = { pm: { "0xAB|Yes": { pts: [[NOW - 3 * H, 0.4], [NOW - H, 0.55], [NOW, 0.6]] } } };
  const q = { venue: "hl", coin: "BTC", openedAt: new Date(NOW - H).toISOString(), pm: { cid: "0xab", outcome: "Yes" } };
  assert.deepEqual(withSignalOdds(q, { history, pmPrices: { "0xAB|Yes": 0.62 } }).pm, { cid: "0xab", outcome: "Yes", entryOdds: 0.55, odds: 0.62 });
  assert.equal(withSignalOdds({ ...q, pm: { ...q.pm, entryOdds: 0.5 } }, { history }).pm.entryOdds, 0.5);   // fixée une fois pour toutes
});
