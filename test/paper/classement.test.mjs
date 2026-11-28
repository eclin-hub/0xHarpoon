// Classement dynamique des modèles LLM (llm_ranking.mjs) : minimum de 6 votants actifs, plafond de 30 % avec
// redistribution, mise en sourdine d'un modèle faible et repêchage automatique par ses votes en ombre.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankModels, capWeights, voterWeights, scoreOf, performance, updateHealth, recordCycle, emptyRanking, MIN_ACTIVE_VOTERS, MAX_WEIGHT } from "../../lib/paper/llm_ranking.mjs";
import { LLMRouter } from "../../lib/paper/router.mjs";
import { decide, tallyCandidate } from "../../lib/paper/decision.mjs";
import { addShadows } from "../../lib/paper/shadow.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3, D = 24 * H;
const iso = (t) => new Date(t).toISOString();
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
// 9 modèles décisionnels de 8 familles (m8 partage la famille de m1) + 1 modèle ombre de configuration
const MODELS = [...Array.from({ length: 8 }, (_, i) => ({ model: `m${i + 1}`, family: `f${i + 1}`, provider: "p" })), { model: "m9", family: "f1", provider: "q" },
  { model: "sh", family: "fs", provider: "p", shadowOnly: true }];
// trades fantômes clos : R donnés, du plus ancien au plus récent
const trades = (model, Rs, end = NOW - H) => Rs.map((R, i) => ({ model, family: "x", candidateId: `c${i}`, R, closedAt: iso(end - (Rs.length - i) * H), exit: "horizon" }));
const book = (...xs) => ({ open: [], closed: xs.flat() });
const GOOD = [1.5, 2, -1, 1.2, 0.8, 1.1, -0.5, 1.4], BAD = [-1, -1, -0.8, -1, 0.2, -1, -1, -0.9];

test("score : prior neutre 1,0 sous 5 trades clos ; bons et mauvais résultats lissés ; fenêtre 30 j / 40 trades ; pénalité d'échecs légère", () => {
  assert.equal(scoreOf(performance([3, 3, 3, 3])).score, 1);                         // 4 trades : neutre, même parfaits
  const good = scoreOf(performance(GOOD)).score, bad = scoreOf(performance(BAD)).score;
  assert.ok(good > 1.3 && good < 2, String(good)); assert.ok(bad < 0.6, String(bad));
  assert.ok(scoreOf(performance(GOOD), 1).score >= good * 0.7 - 1e-4 && scoreOf(performance(GOOD), 0.3).score < good);   // au plus −30 %
  // trades hors fenêtre (31 jours) ignorés ; 40 au plus
  const r = rankModels({ models: [MODELS[0]], book: book(trades("m1", BAD, NOW - 31 * D), trades("m1", Array(50).fill(1))), now: NOW });
  assert.equal(r.models[0].trades, 40); assert.equal(r.models[0].winRate, 1);
  // santé : moyenne mobile des échecs, d'après le journal du routeur
  let hl = updateHealth({}, [{ model: "m1", ok: false, error: "HTTP 429" }, { model: "m2", ok: true }], NOW);
  assert.equal(hl.m1.fails, 0.3); assert.equal(hl.m2.fails, 0); assert.equal(hl.m1.lastError, "HTTP 429");
  hl = updateHealth(hl, [{ model: "m1", ok: true }], NOW); assert.equal(hl.m1.fails, 0.21);
});

test("(1) au moins 6 votants actifs de familles distinctes ; 100 % des modèles quand moins de 6 sont disponibles", () => {
  const r = rankModels({ models: MODELS, book: book(trades("m2", GOOD), trades("m3", BAD)), now: NOW });
  assert.equal(MIN_ACTIVE_VOTERS, 6);
  assert.equal(r.active.length, 6);
  assert.equal(new Set(r.active.map((m) => MODELS.find((x) => x.model === m).family)).size, 6);   // m1 et m9 jamais ensemble
  assert.equal(r.active[0], "m2");                                                                 // le meilleur en tête
  assert.ok(!r.active.includes("m3"));                                                             // le mauvais en sourdine
  assert.ok(!r.active.includes("sh")); assert.equal(r.models.find((m) => m.model === "sh").status, "Ombre (config)");
  assert.ok(Math.abs(sum(Object.fromEntries(r.models.map((m) => [m.model, m.weight]))) - 1) < 1e-3);
  // 3 modèles seulement : tous actifs, même un mauvais
  const few = rankModels({ models: MODELS.slice(0, 3), book: book(trades("m3", BAD)), now: NOW });
  assert.deepEqual(few.active.sort(), ["m1", "m2", "m3"]); assert.deepEqual(few.probes, []);
  assert.ok(few.models.every((m) => m.weight > 0));
  // ordre transmis au routeur : actifs d'abord, puis la réserve (remplaçants)
  assert.deepEqual(r.order.slice(0, 6), r.active); assert.equal(r.order.length, 9);
});

test("(2) plafond strict de 30 % : l'excédent est redistribué au prorata, somme 1 ; moins de 4 votants → 1/n", () => {
  assert.equal(MAX_WEIGHT, 0.3);
  const w = capWeights({ a: 10, b: 1, c: 1, d: 1, e: 1, f: 1 });
  assert.equal(w.a, 0.3); for (const k of "bcdef") assert.equal(w[k], 0.14);
  assert.ok(Math.abs(sum(w) - 1) < 1e-3);
  // deux modèles au-dessus du plafond, puis un troisième poussé au-dessus par la redistribution
  const w2 = capWeights({ a: 100, b: 50, c: 9, d: 3, e: 2, f: 1 });
  assert.equal(w2.a, 0.3); assert.equal(w2.b, 0.3); assert.ok(w2.c <= 0.3 + 1e-9);
  assert.ok(Object.values(w2).every((x) => x <= 0.3 + 1e-9)); assert.ok(Math.abs(sum(w2) - 1) < 1e-3);
  assert.ok(w2.d > w2.e && w2.e > w2.f);                                             // proportionnalité gardée sous le plafond
  // un modèle parfait face à 5 modèles faibles (43 % sans plafond) n'emporte jamais plus de 30 %
  const r = rankModels({ models: MODELS.slice(0, 6), book: book(trades("m1", Array(40).fill(3)), ...["m2", "m3", "m4", "m5", "m6"].map((m) => trades(m, BAD))), now: NOW });
  assert.equal(r.active.length, 6); assert.equal(r.models.find((m) => m.model === "m1").weight, 0.3);
  assert.ok(Math.abs(sum(Object.fromEntries(r.models.map((m) => [m.model, m.weight]))) - 1) < 1e-3);
  // 2 votants : 30 % est impossible, poids égaux au plus
  assert.deepEqual(capWeights({ a: 5, b: 1 }), { a: 0.5, b: 0.5 });
  assert.deepEqual(voterWeights(["x", "y"], null), { x: 0.5, y: 0.5 });
});

test("(3) un modèle faible passe à 0 % et vote en ombre par rotation ; il redevient actif dès qu'il remonte dans le Top 6", () => {
  const ms = MODELS.slice(0, 8);                                                     // 8 familles : 6 actifs, 2 en sourdine
  const base = [trades("m1", GOOD), trades("m2", GOOD), trades("m3", GOOD), trades("m4", GOOD), trades("m5", GOOD), trades("m6", GOOD.map((x) => x * 0.5))];
  let st = rankModels({ models: ms, book: book(...base, trades("m8", BAD)), state: emptyRanking(), now: NOW });
  const m8 = () => st.models.find((m) => m.model === "m8");
  assert.ok(!st.active.includes("m8")); assert.equal(m8().weight, 0); assert.match(m8().status, /^Ombre 0 %/);
  assert.deepEqual(st.probes.sort(), ["m7", "m8"]);                                  // 2 modèles en sourdine tirés à chaque réveil
  // vrai routeur, faux serveur : m8 (en sourdine) vote OPEN en ombre, poids nul ; les 6 actifs votent avec leurs poids
  const CAND = { id: "hl|BTC|long", type: "whale", venue: "hl", coin: "BTC", side: "long", pocket: "core", score: 3, metrics: { mark: 100, atr14: 2, dist_atr: 0.55 } };
  const vote = (action) => ({ votes: [{ candidate_id: CAND.id, action, conviction: 80, invalidation_condition: "retour sous l'entrée", horizon_hours: 48, cited_risk_metric: "dist_atr = 0.55" }] });
  const asked = [];
  const f = async (url, init) => { const m = JSON.parse(init.body).model; asked.push(m); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(vote(m === "m8" ? "OPEN" : "REJECT")) } }] }), { status: 200 }); };
  const router = new LLMRouter({ env: { K: "k" }, providers: [{ name: "p", url: "https://example.test/v1", keyEnv: "K", models: ms.map((m) => ({ id: m.model, family: m.family, role: "voter" })) }], fetch: f });
  return (async () => {
    const d = await decide({ router, dossier: { wakeLLM: true, candidates: [CAND], rejected: [] }, portfolio: initialPortfolio(), now: NOW, ranking: st });
    assert.deepEqual(Object.keys(d.weights).sort(), [...st.active].sort());
    assert.ok(Math.abs(sum(d.weights) - 1) < 1e-3 && Object.values(d.weights).every((w) => w <= 0.3 + 1e-9));
    const p8 = d.votes.find((v) => v.model === "m8");
    assert.equal(p8.weight, 0); assert.equal(p8.probe, true); assert.equal(asked.filter((m) => m === "m8").length, 1);   // jamais aussi en remplaçant
    assert.equal(d.decisions.length, 0);                                             // son OPEN ne pèse rien en live
    const rec = recordCycle(st, d.weights, d.probes);
    assert.equal(rec.models.find((m) => m.model === "m8").weight, 0);
    // son vote alimente le shadow book…
    const sb = addShadows(null, d.votes, { candidates: [CAND] }, NOW).book;
    assert.ok(sb.open.some((s) => s.model === "m8"));
    // …puis ses bons appels en ombre le font remonter : il redevient actif et récupère du poids, sans intervention
    const later = NOW + 10 * D;
    st = rankModels({ models: ms, book: book(...base, trades("m8", BAD, NOW), trades("m8", Array(30).fill(2), later)), state: rec, now: later });
    assert.ok(st.active.includes("m8"), st.active.join()); assert.ok(m8().weight > 0); assert.equal(m8().status, "Actif");
    assert.ok(!st.active.includes("m6") || !st.active.includes("m7"));               // un autre a cédé sa place
  })();
});

test("rotation du repêchage : les modèles en sourdine sont tirés à tour de rôle", () => {
  const ms = Array.from({ length: 10 }, (_, i) => ({ model: `n${i}`, family: `g${i}`, provider: "p" }));   // 6 actifs, 4 en sourdine
  const b = book(...ms.slice(0, 6).map((m) => trades(m.model, GOOD)));
  let st = emptyRanking(); const seen = [];
  for (let k = 0; k < 2; k++) { st = rankModels({ models: ms, book: b, state: st, now: NOW }); seen.push(...st.probes); }
  assert.deepEqual(seen.sort(), ["n6", "n7", "n8", "n9"]);                         // en 2 réveils, les 4 ont voté en ombre
});

test("dépouillement pondéré : 4 OPEN sur 6 ouvrent sans arbitre si leur poids ≥ 75 %, arbitre à poids égaux ; conviction pondérée", () => {
  const v = (model, action, weight, conviction = 80) => ({ candidate_id: "x", model, action, weight, conviction, valid: true });
  const heavy = [v("a", "OPEN", 0.3, 90), v("b", "OPEN", 0.3, 70), v("c", "OPEN", 0.1, 60), v("d", "OPEN", 0.1, 60), v("e", "REJECT", 0.1), v("f", "REJECT", 0.1)];
  const t = tallyCandidate("x", heavy);
  assert.equal(t.status, "open"); assert.match(t.via, /majorité pondérée 80 %/);
  assert.equal(t.conviction, Math.round((0.3 * 90 + 0.3 * 70 + 0.1 * 60 + 0.1 * 60) / 0.8));
  const equal = heavy.map((x) => ({ ...x, weight: 1 / 6 }));
  assert.equal(tallyCandidate("x", equal).status, "arbiter");                       // 4/6 = 67 % : arbitre
  assert.equal(tallyCandidate("x", [v("a", "OPEN", 0.1), ...["b", "c", "d", "e", "f"].map((m) => v(m, "REJECT", 0.18))]).status, "reject");
  // à 3 votants égaux on retrouve l'ancienne règle : 2 contre 1 → arbitre
  assert.equal(tallyCandidate("x", [v("a", "OPEN", 1 / 3), v("b", "OPEN", 1 / 3), v("c", "REJECT", 1 / 3)]).status, "arbiter");
});
