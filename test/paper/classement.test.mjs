// Classement dynamique des modèles LLM (llm_ranking.mjs) : TOUS les modèles décisionnels votent à chaque réveil, avec un
// poids continu borné entre 4 % et 30 % ; poids nul pour les seuls modèles shadowOnly ; part d'un modèle muet redistribuée.
// Routeur : appels parallèles à tous les votants, 400 ms entre deux requêtes vers OpenRouter, JSON habillé toléré.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankModels, boundedWeights, capWeights, targetWeights, voterWeights, scoreOf, performance, updateHealth, recordCycle, errorCode, emptyRanking,
  MAX_WEIGHT, MIN_WEIGHT } from "../../lib/paper/llm_ranking.mjs";
import { LLMRouter } from "../../lib/paper/router.mjs";
import { extractJson } from "../../lib/paper/schema.mjs";
import { decide, tallyCandidate } from "../../lib/paper/decision.mjs";
import { addShadows } from "../../lib/paper/shadow.mjs";
import { runXAlpha, compileLibrary, blueprintExtractor } from "../../lib/paper/x_scraper.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3, D = 24 * H;
const iso = (t) => new Date(t).toISOString();
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const trades = (model, Rs, end = NOW - H) => Rs.map((R, i) => ({ model, family: "x", candidateId: `c${i}`, R, closedAt: iso(end - (Rs.length - i) * H), exit: "horizon" }));
const book = (...xs) => ({ open: [], closed: xs.flat() });
const GOOD = [1.5, 2, -1, 1.2, 0.8, 1.1, -0.5, 1.4], BAD = [-1, -1, -0.8, -1, 0.2, -1, -1, -0.9];
// 12 modèles décisionnels (m1 et m12 de la même famille, comme llama 3.3 sur Cerebras et OpenRouter) + 2 modèles ombre
const DEC = Array.from({ length: 12 }, (_, i) => ({ model: `m${i + 1}`, family: i === 11 ? "f1" : `f${i + 1}`, provider: "p" }));
const MODELS = [...DEC, { model: "sh1", family: "gemini", provider: "g", shadowOnly: true }, { model: "sh2", family: "ernie", provider: "o", shadowOnly: true }];
const CAND = { id: "hl|BTC|long", type: "whale", venue: "hl", coin: "BTC", side: "long", pocket: "core", score: 3, metrics: { mark: 100, atr14: 2, dist_atr: 0.55 } };
const ballot = (action) => ({ votes: [{ candidate_id: CAND.id, action, conviction: 80, invalidation_condition: "retour sous l'entrée", horizon_hours: 48, cited_risk_metric: "dist_atr = 0.55" }] });
const routerFor = (models, f, extra = {}) => new LLMRouter({ env: { K: "k" }, fetch: f, ...extra,
  providers: [{ name: "p", url: "https://example.test/v1", keyEnv: "K", models: models.map((m) => ({ id: m.model, family: m.family, ...(m.shadowOnly ? { shadowOnly: true } : { role: "voter" }) })) }] });
const reply = (fn) => async (url, init) => { const m = JSON.parse(init.body).model; const r = fn(m); return r instanceof Response ? r : new Response(JSON.stringify({ choices: [{ message: { content: typeof r === "string" ? r : JSON.stringify(r) } }] }), { status: 200 }); };

test("score : prior neutre 1,0 sous 5 trades clos ; bons et mauvais résultats lissés ; fenêtre 30 j / 40 trades ; pénalité d'échecs légère", () => {
  assert.equal(scoreOf(performance([3, 3, 3, 3])).score, 1);
  const good = scoreOf(performance(GOOD)).score, bad = scoreOf(performance(BAD)).score;
  assert.ok(good > 1.3 && good < 2, String(good)); assert.ok(bad < 0.6, String(bad));
  assert.ok(scoreOf(performance(GOOD), 1).score >= good * 0.7 - 1e-4 && scoreOf(performance(GOOD), 0.3).score < good);
  const r = rankModels({ models: [DEC[0]], book: book(trades("m1", BAD, NOW - 31 * D), trades("m1", Array(50).fill(1))), now: NOW });
  assert.equal(r.models[0].trades, 40); assert.equal(r.models[0].winRate, 1);
  let hl = updateHealth({}, [{ model: "m1", ok: false, error: "HTTP 429" }, { model: "m2", ok: true }], NOW);
  assert.equal(hl.m1.fails, 0.3); assert.equal(hl.m2.fails, 0); assert.equal(hl.m1.lastError, "HTTP 429");
  hl = updateHealth(hl, [{ model: "m1", ok: true }], NOW); assert.equal(hl.m1.fails, 0.21);
});

test("(1) tous les modèles non shadowOnly participent à chaque réveil, sans limite à 6 ni contrainte de famille", async () => {
  const r = rankModels({ models: MODELS, book: book(trades("m2", GOOD), trades("m3", BAD)), now: NOW });
  assert.equal(r.active.length, 12); assert.deepEqual(r.probes, []);
  assert.ok(r.active.includes("m1") && r.active.includes("m12"));                    // même famille : les deux votent
  assert.ok(r.models.filter((m) => !m.shadowOnly).every((m) => m.status === "Actif"));
  // vrai routeur, faux serveur : les 12 votent, les 2 modèles ombre aussi (poids nul)
  const asked = [];
  const router = routerFor(MODELS, reply((m) => { asked.push(m); return ballot(m.startsWith("sh") ? "OPEN" : "REJECT"); }));
  const d = await decide({ router, dossier: { wakeLLM: true, candidates: [CAND], rejected: [] }, portfolio: initialPortfolio(), now: NOW, ranking: r });
  assert.equal(asked.length, 14); assert.equal(new Set(asked).size, 14);
  assert.deepEqual(Object.keys(d.weights).sort(), r.active.slice().sort());
  assert.equal(d.records[0].n, 12); assert.equal(d.decisions.length, 0);
});

test("(2) poids cible continu : max(0,2 ; score)², strictement positif, borné entre 4 % et 30 %, somme 1", () => {
  assert.equal(MIN_WEIGHT, 0.04); assert.equal(MAX_WEIGHT, 0.3);
  // un excellent, un très mauvais et dix neutres
  const r = rankModels({ models: MODELS, book: book(trades("m1", Array(40).fill(3)), trades("m2", Array(40).fill(-1))), now: NOW });
  const act = r.models.filter((m) => !m.shadowOnly);
  assert.ok(act.every((m) => m.target > 0 && m.target <= 0.3 + 1e-9), JSON.stringify(act.map((m) => [m.model, m.target])));
  // bornes 4 % / 30 % par voix (famille) : m1 et m12 partagent celle de f1
  const fam = {}; for (const m of act) fam[m.family] = (fam[m.family] ?? 0) + m.target;
  assert.ok(Object.values(fam).every((x) => x >= 0.04 - 1e-3 && x <= 0.3 + 1e-3), JSON.stringify(fam));
  assert.ok(Math.abs(sum(r.target) - 1) < 1e-3);
  const t = Object.fromEntries(act.map((m) => [m.model, m.target]));
  assert.equal(t.m2, 0.04);                                                           // le plus mauvais garde une voix réelle
  assert.ok(t.m1 > t.m3 && t.m3 > t.m2);                                              // ordre des scores respecté
  // un modèle parfait face à 5 très faibles : plafonné à 30 %, les faibles au-dessus du plancher, rapport ≤ 7,5
  const w = targetWeights({ a: 2, b: 0.05, c: 0.05, d: 0.05, e: 0.05, f: 0.05 });
  assert.equal(w.a, 0.3); for (const k of "bcdef") assert.equal(w[k], 0.14);
  const spread = targetWeights(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`x${i}`, i === 0 ? 2 : 0.05])));
  assert.equal(spread.x0, 0.3); assert.ok(Object.values(spread).every((x) => x >= 0.04 - 1e-9)); assert.ok(spread.x0 / Math.min(...Object.values(spread)) <= 7.5 + 1e-6);
  // bornes infaisables : 2 modèles → 50 % chacun ; 30 modèles → plancher 1/30
  assert.deepEqual(targetWeights({ a: 2, b: 0.1 }), { a: 0.5, b: 0.5 });
  const many = targetWeights(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`y${i}`, 1 + i / 30])));
  assert.ok(Object.values(many).every((x) => Math.abs(x - 1 / 30) < 1e-3));
  // remplissage par niveaux : deux au plafond, un poussé au-dessus par la redistribution, plafond seul compatible
  const w2 = capWeights({ a: 100, b: 50, c: 9, d: 3, e: 2, f: 1 });
  assert.equal(w2.a, 0.3); assert.equal(w2.b, 0.3); assert.ok(Object.values(w2).every((x) => x <= 0.3 + 1e-9)); assert.ok(Math.abs(sum(w2) - 1) < 1e-3);
  assert.deepEqual(boundedWeights({ a: 1, b: 1, c: 1, d: 1 }), { a: 0.25, b: 0.25, c: 0.25, d: 0.25 });
});

test("une voix par modèle : les copies d'un même modèle (même famille, plusieurs fournisseurs) votent mais partagent un poids", async () => {
  // llama 3.3 70b sur Cerebras et OpenRouter (famille commune), 4 autres modèles ; tous au score neutre
  const ms = [{ model: "llama-cerebras", family: "llama", provider: "c" }, { model: "llama-openrouter", family: "llama", provider: "o" },
    ...["a", "b", "c", "d"].map((x) => ({ model: x, family: x, provider: "p" }))];
  const r = rankModels({ models: ms, now: NOW });
  assert.equal(r.active.length, 6);                                                       // les deux copies votent
  assert.equal(r.target["llama-cerebras"] + r.target["llama-openrouter"], 0.2);          // ensemble : une voix sur 5
  assert.equal(r.target["llama-cerebras"], 0.1); assert.equal(r.target.a, 0.2);
  assert.deepEqual(r.models.find((m) => m.model === "llama-cerebras").sharedWith, ["llama-openrouter"]);
  // au vote : les deux répondent → 10 % chacune ; une copie muette → l'autre porte seule la voix de la famille
  const both = voterWeights(r.active, r), one = voterWeights(r.active.filter((m) => m !== "llama-openrouter"), r);
  assert.equal(both["llama-cerebras"], 0.1); assert.equal(one["llama-cerebras"], 0.2); assert.equal(one.a, 0.2);
  // décision réelle : 6 bulletins, mais la somme des poids des deux copies ne dépasse pas une voix
  const router = routerFor(ms, reply(() => ballot("REJECT")));
  const d = await decide({ router, dossier: { wakeLLM: true, candidates: [CAND], rejected: [] }, portfolio: initialPortfolio(), now: NOW, ranking: r });
  assert.equal(d.records[0].n, 6); assert.equal(d.weights["llama-cerebras"] + d.weights["llama-openrouter"], 0.2);
});

test("(3) poids 0 % uniquement pour les modèles shadowOnly ; leurs votes restent dans le shadow book", async () => {
  const r = rankModels({ models: MODELS, book: book(trades("sh1", Array(40).fill(3))), now: NOW });   // même excellent, un shadowOnly reste à 0
  for (const m of r.models) assert.equal(m.weight === 0, m.shadowOnly, m.model);
  assert.equal(r.models.find((m) => m.model === "sh1").status, "Ombre (config)");
  const router = routerFor(MODELS, reply((m) => ballot(m.startsWith("sh") ? "OPEN" : "REJECT")));
  const d = await decide({ router, dossier: { wakeLLM: true, candidates: [CAND], rejected: [] }, portfolio: initialPortfolio(), now: NOW, ranking: r });
  const zero = d.votes.filter((v) => v.weight === 0).map((v) => v.model).sort();
  assert.deepEqual(zero, ["sh1", "sh2"]); assert.ok(d.votes.filter((v) => !v.shadowOnly).every((v) => v.weight >= 0.04 - 1e-9 && v.weight <= 0.3 + 1e-9));
  const sb = addShadows(null, d.votes, { candidates: [CAND] }, NOW).book;
  assert.deepEqual(sb.open.map((s) => s.model).sort(), ["sh1", "sh2"]);
});

test("modèle actif sans réponse : 0 sur ce cycle, sa part redistribuée au prorata ; cause courte affichée", async () => {
  const ms = DEC.slice(0, 8), r = rankModels({ models: ms, book: book(trades("m1", GOOD)), now: NOW });
  const f = reply((m) => (m === "m2" ? new Response('{"error":{"message":"Rate limit reached for model in organization on tokens per minute (TPM): Limit 8000, Used 7900"}}', { status: 429 })
    : m === "m3" ? "Je ne peux pas répondre." : ballot("REJECT")));
  const router = routerFor(ms, f);
  const d = await decide({ router, dossier: { wakeLLM: true, candidates: [CAND], rejected: [] }, portfolio: initialPortfolio(), now: NOW, ranking: r });
  const answered = ["m1", "m4", "m5", "m6", "m7", "m8"];
  assert.deepEqual(Object.keys(d.weights).sort(), answered);
  assert.ok(Math.abs(sum(d.weights) - 1) < 1e-3);
  assert.ok(Object.values(d.weights).every((w) => w >= 0.04 - 1e-9 && w <= 0.3 + 1e-9));
  // prorata des poids cibles des répondants : la part des muets (m2, m3) est redistribuée ; m1 bute sur le plafond de 30 %,
  // les autres gardent entre eux les rapports de leurs poids cibles
  assert.equal(d.weights.m1, 0.3);
  for (const m of answered.slice(2)) assert.ok(Math.abs(d.weights[m] / d.weights.m4 - r.target[m] / r.target.m4) < 0.02, `${m} : rapport ${d.weights[m] / d.weights.m4}`);
  assert.ok(d.weights.m4 > r.target.m4);                                                  // chacun récupère une part des muets
  assert.ok(d.weights.m1 > d.weights.m4);                                                 // le mieux classé garde l'avantage
  const rec = recordCycle(r, d.weights, router.log), by = Object.fromEntries(rec.models.map((m) => [m.model, m]));
  assert.equal(by.m2.status, "Actif · sans réponse · 429 TPM"); assert.equal(by.m2.cycle, 0); assert.ok(by.m2.target > 0);
  assert.match(by.m2.cycleError.message, /tokens per minute/);
  assert.equal(by.m3.status, "Actif · sans réponse · JSON");
  assert.equal(by.m1.status, "Actif"); assert.equal(by.m1.cycle, d.weights.m1);
  assert.equal(errorCode("HTTP 404 : No endpoints found matching your data policy"), "404 policy");
  assert.equal(errorCode("HTTP 404 : model not found"), "404 modèle");
  assert.equal(errorCode("The operation was aborted due to timeout"), "délai");
  assert.equal(errorCode("HTTP 503 : overloaded"), "5xx serveur");
});

test("OpenRouter : 400 ms au moins entre deux requêtes vers openrouter.ai, même en parallèle ; les autres hôtes ne sont pas retardés", async () => {
  const waits = [], sleep = async (ms) => { waits.push(ms); };
  const providers = [{ name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "O", models: ["a", "b", "c"].map((id) => ({ id, family: id, role: "voter" })) },
    { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "G", models: [{ id: "g", family: "g", role: "voter" }] }];
  const r = new LLMRouter({ env: { O: "o", G: "g" }, providers, sleep, fetch: reply(() => ballot("REJECT")) });
  const out = await r.collectAll([], (j) => ({ ok: true, value: j }));
  assert.equal(out.results.length, 4);
  assert.equal(waits.length, 2);                                                       // 1re requête immédiate, puis 2 décalées
  assert.ok(Math.abs(waits[0] - 400) <= 50 && Math.abs(waits[1] - 800) <= 50, waits.join());
});

test("JSON habillé : balises markdown, texte avant / après, accolades dans la prose, </think> seul, virgules finales", () => {
  assert.deepEqual(extractJson('Voici mon vote :\n```json\n{"votes":[]}\n```\nBonne journée.'), { votes: [] });
  assert.deepEqual(extractJson('Avec {des accolades} dans la prose. Réponse : {"votes":[1]} fin.'), { votes: [1] });
  assert.deepEqual(extractJson('```python\nx = {1: 2}\n```\n```JSON\n{"ok": true}\n```'), { ok: true });
  assert.deepEqual(extractJson('je réfléchis…</think>\n{"ok": 1}'), { ok: 1 });
  assert.deepEqual(extractJson('{"a": [1, 2,], "b": 3,}'), { a: [1, 2], b: 3 });
  assert.throws(() => extractJson("pas de JSON"), /aucun JSON/); assert.throws(() => extractJson('{"a": 1'), /incomplet/);
});

test("Blueprints compilés après le vote : collecte sans compilation, puis compileLibrary ; mistral-small essayé en premier", async () => {
  const posts = { "arxiv:1": { id: "arxiv:1", kind: "infinity", interest: 80, src: "arxiv", author: "A", text: "Momentum factor.", t: NOW - H, url: null } };
  let calls = 0;
  const ex = async () => { calls++; return { blueprint: { name: "Momentum", thesis: "t", universe: ["BTC"], side: "both", horizon_hours: 24, blocks: [{ type: "momentum", weight: 1, params: {} }], entry: { score_above: 0.2 }, exit: { stop_atr: 2, max_hold_hours: 24 } }, model: "mistral-small-latest" }; };
  const { alpha, cache } = await runXAlpha({ cache: { posts }, env: {}, free: false, net: false, now: NOW, deferCompile: true, extract: ex });
  assert.equal(calls, 0); assert.equal(alpha.infinity.blueprints.length, 0); assert.equal(alpha.infinity.translator, "après le vote de trading");
  assert.ok(!alpha.notes.some((n) => /traducteur indisponible/.test(n)));
  const after = await compileLibrary(alpha, cache, ex, { now: NOW, env: { MISTRAL_API_KEY: "m", GROQ_API_KEY: "g" } });
  assert.equal(calls, 1); assert.equal(after.alpha.infinity.blueprints.length, 1); assert.match(after.alpha.infinity.translator, /^mistral-small → qwen3.8/);
  const order = [];
  const ext = blueprintExtractor({ env: { MISTRAL_API_KEY: "m", GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" }, fetch: reply((m) => { order.push(m); return { none: true }; }) });
  await ext({ author: "a", text: "x", src: "arxiv" });
  assert.deepEqual(order, ["mistral-small-latest", "qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openrouter/free"]);
});

test("dépouillement pondéré : 4 OPEN sur 6 ouvrent sans arbitre si leur poids ≥ 75 %, arbitre à poids égaux ; conviction pondérée", () => {
  const v = (model, action, weight, conviction = 80) => ({ candidate_id: "x", model, action, weight, conviction, valid: true });
  const heavy = [v("a", "OPEN", 0.3, 90), v("b", "OPEN", 0.3, 70), v("c", "OPEN", 0.1, 60), v("d", "OPEN", 0.1, 60), v("e", "REJECT", 0.1), v("f", "REJECT", 0.1)];
  const t = tallyCandidate("x", heavy);
  assert.equal(t.status, "open"); assert.match(t.via, /majorité pondérée 80 %/);
  assert.equal(t.conviction, Math.round((0.3 * 90 + 0.3 * 70 + 0.1 * 60 + 0.1 * 60) / 0.8));
  assert.equal(tallyCandidate("x", heavy.map((x) => ({ ...x, weight: 1 / 6 }))).status, "arbiter");
  assert.equal(tallyCandidate("x", [v("a", "OPEN", 0.1), ...["b", "c", "d", "e", "f"].map((m) => v(m, "REJECT", 0.18))]).status, "reject");
  assert.equal(tallyCandidate("x", [v("a", "OPEN", 1 / 3), v("b", "OPEN", 1 / 3), v("c", "REJECT", 1 / 3)]).status, "arbiter");
  assert.deepEqual(voterWeights(["x", "y"], null), { x: 0.5, y: 0.5 });
  assert.deepEqual(emptyRanking().probes, []);
});
