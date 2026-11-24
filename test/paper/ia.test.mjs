import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, validateVote, validateBallot, validateArbiter, checkCitation } from "../../lib/paper/schema.mjs";
import { LLMRouter } from "../../lib/paper/router.mjs";
import { decide, wakeReasons, nearStop, tallyCandidate } from "../../lib/paper/decision.mjs";
import { executeDecisions } from "../../lib/paper/execute.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";
import { openHl } from "../../lib/paper/simulator.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const NOW = Date.UTC(2026, 10, 24, 10);
const vote = (id, action, conviction = 80, cited = "dist_atr = 0.55") => ({ candidate_id: id, action, conviction, invalidation_condition: "retour sous l'entrée des baleines", horizon_hours: 72, cited_risk_metric: cited });

/* ---------- schéma ---------- */

test("extractJson : bloc ```json, balise <think>, texte autour, accolades dans les chaînes", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('<think>hmm {"x":0}</think>Voici : {"votes":[{"s":"a}b"}]} fin'), { votes: [{ s: "a}b" }] });
  assert.throws(() => extractJson("pas de json"), /aucun JSON/);
});

test("validateVote / validateBallot : schéma strict", () => {
  const ids = ["c1", "hl-1"];
  assert.equal(validateVote(vote("c1", "OPEN", 79.6), ids).vote.conviction, 80);
  assert.match(validateVote({ ...vote("c1", "OPEN"), size: 1e6 }, ids).error, /champ inconnu : size/);   // l'IA ne peut pas glisser une taille
  assert.match(validateVote(vote("c9", "OPEN"), ids).error, /inconnu/);
  assert.match(validateVote(vote("c1", "BUY"), ids).error, /action/);
  assert.match(validateVote(vote("c1", "OPEN", 101), ids).error, /conviction/);
  const { horizon_hours, ...noH } = vote("c1", "OPEN");
  assert.match(validateVote(noH, ids).error, /manquant : horizon_hours/);
  const b = validateBallot({ votes: [vote("c1", "OPEN"), vote("c1", "REJECT"), vote("zz", "OPEN"), vote("hl-1", "HOLD")] }, ids);
  assert.equal(b.votes.length, 2); assert.equal(b.errors.length, 2);
  assert.equal(validateBallot(vote("c1", "OPEN"), ids).votes.length, 1);
  assert.equal(validateBallot("x", ids).ok, false);
  assert.equal(validateArbiter({ candidate_id: "c1", action: "OPEN", conviction: 70, reason: "ok", cited_metric: "dist_atr 0.55" }, "c1").ok, true);
  assert.match(validateArbiter({ candidate_id: "c1", action: "HOLD", conviction: 70, reason: "ok", cited_metric: "x" }, "c1").error, /OPEN ou REJECT/);
});

test("checkCitation : nom de la métrique ET sa valeur", () => {
  const m = { dist_atr: 0.55, funding_apr: 0.1095, long_leg: { atr14: 4 } };
  assert.equal(checkCitation("dist_atr = 0.55", m).key, "dist_atr");
  assert.equal(checkCitation("Dist ATR de 0,55 : trop tard", m).ok, true);
  assert.equal(checkCitation("funding_apr à 10.95 %", m).key, "funding_apr");
  assert.equal(checkCitation("long_leg.atr14 = 4", m).key, "long_leg.atr14");
  assert.equal(checkCitation("dist_atr trop élevé", m).ok, false);
  assert.equal(checkCitation("0.55", m).ok, false);
  assert.equal(checkCitation("dist_atr = 0.9", m).ok, false);
});

/* ---------- routeur ---------- */

const PROVIDERS = [
  { name: "p1", url: "https://p1/chat", keyEnv: "K1", models: [{ id: "A", family: "a" }, { id: "B", family: "a" }, { id: "C", family: "c" }] },
  { name: "p2", url: "https://p2/chat", keyEnv: "K2", models: [{ id: "Z", family: "z" }] },
  { name: "p3", url: "https://p3/chat", keyEnv: "K3", models: [{ id: "D", family: "d" }, { id: "E", family: "e" }, { id: "F", family: "f" }] },
];
const ok = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

function fakeFetch(behaviour) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, model: body.model, json: !!body.response_format, auth: init.headers.authorization });
    return behaviour(body.model, body);
  };
  f.calls = calls;
  return f;
}

test("LLMRouter : fournisseurs sans clé ignorés, familles distinctes, repli après échec", async () => {
  const f = fakeFetch((model) => (model === "A" ? new Response("", { status: 429 }) : model === "C" ? ok("pas du json") : ok('{"ok":true}')));
  const r = new LLMRouter({ env: { K1: "k1", K3: "k3" }, providers: PROVIDERS, fetch: f });
  assert.deepEqual(r.available().map((x) => x.model), ["A", "B", "C", "D", "E", "F"]);
  const out = await r.collect(3, [], (j) => (j.ok ? { ok: true, value: j } : { ok: false, error: "x" }));
  assert.deepEqual(out.results.map((x) => x.model).sort(), ["B", "D", "E"]);
  assert.equal(new Set(out.results.map((x) => x.family)).size, 3);
  assert.equal(out.errors.length, 2);   // A (429) et C (JSON invalide)
  assert.ok(f.calls.every((c) => c.auth === "Bearer k1" || c.auth === "Bearer k3"));
  assert.ok(!f.calls.some((c) => c.model === "Z"));
  // l'arbitre ne peut pas être d'une famille déjà utilisée
  const arb = await r.collect(1, [], (j) => ({ ok: true, value: j }), { excludeFamilies: ["a", "d", "e"] });
  assert.equal(arb.results[0].model, "F");
});

test("LLMRouter : mode JSON refusé (HTTP 400) → nouvel essai sans response_format", async () => {
  const f = fakeFetch((model, body) => (body.response_format ? new Response("", { status: 400 }) : ok('{"v":1}')));
  const r = new LLMRouter({ env: { K3: "k" }, providers: [PROVIDERS[2]], fetch: f });
  const out = await r.collect(1, [], (j) => ({ ok: true, value: j }));
  assert.deepEqual(out.results[0].value, { v: 1 });
  assert.deepEqual(f.calls.map((c) => c.json), [true, false]);
});

/* ---------- décision ---------- */

const CAND = { id: "hl|BTC|long", type: "whale", venue: "hl", coin: "BTC", side: "long", pocket: "core", score: 3, metrics: { mark: 100, atr14: 2, dist_atr: 0.55 } };
const dossier = (cands = [CAND]) => ({ wakeLLM: true, candidates: cands, rejected: [] });

class FakeRouter {
  constructor(ballots, arbiter = null) { this.ballots = ballots; this.arbiter = arbiter; this.calls = []; }
  available() { return [{}]; }
  async collect(n, messages, validate, opts = {}) {
    this.calls.push({ n, exclude: opts.excludeFamilies || [] });
    const src = n === 1 && this.calls.length > 1 ? (this.arbiter ? [this.arbiter] : []) : this.ballots;
    const results = [];
    for (const b of src) { const v = validate(b.json); if (v.ok) results.push({ provider: "fake", model: b.family, family: b.family, value: v.value }); }
    return { results, errors: [] };
  }
}
const ballot = (family, votes) => ({ family, json: { votes } });

test("decide : unanimité OPEN → conviction moyenne, sans arbitre", async () => {
  const r = new FakeRouter([ballot("a", [vote(CAND.id, "OPEN", 70)]), ballot("b", [vote(CAND.id, "OPEN", 80)]), ballot("c", [vote(CAND.id, "OPEN", 90)])]);
  const d = await decide({ router: r, dossier: dossier(), portfolio: initialPortfolio(), now: NOW });
  assert.equal(d.mode, "vote"); assert.deepEqual(d.decisions.map((x) => [x.action, x.via, x.conviction]), [["OPEN", "unanimité", 80]]);
  assert.equal(r.calls.length, 1); assert.equal(d.votes.length, 3);
  assert.equal(d.decisions[0].horizonH, 72);
});

test("decide : 2 contre 1 → arbitre d'une autre famille ; objection non chiffrée écartée", async () => {
  const cited = [ballot("a", [vote(CAND.id, "OPEN")]), ballot("b", [vote(CAND.id, "OPEN")]), ballot("c", [vote(CAND.id, "REJECT", 70, "dist_atr = 0.55 : trop tard")])];
  const arb = { family: "d", json: { candidate_id: CAND.id, action: "REJECT", conviction: 65, reason: "trop tard", cited_metric: "dist_atr 0.55" } };
  const r = new FakeRouter(cited, arb);
  const d = await decide({ router: r, dossier: dossier(), portfolio: initialPortfolio(), now: NOW });
  assert.equal(d.decisions.length, 0); assert.equal(d.records[0].via, "arbitre"); assert.equal(d.records[0].arbiter.family, "d");
  assert.deepEqual(r.calls[1].exclude, ["a", "b", "c"]);
  // même vote contre, mais sans métrique : écarté → unanimité des 2 votes valides
  const vague = [cited[0], cited[1], ballot("c", [vote(CAND.id, "REJECT", 70, "je n'aime pas")])];
  const d2 = await decide({ router: new FakeRouter(vague), dossier: dossier(), portfolio: initialPortfolio(), now: NOW });
  assert.equal(d2.decisions[0].via, "unanimité");
  assert.equal(d2.votes.find((v) => v.family === "c").valid, false);
  // arbitre indisponible : pas d'ouverture
  const d3 = await decide({ router: new FakeRouter(cited), dossier: dossier(), portfolio: initialPortfolio(), now: NOW });
  assert.equal(d3.records[0].via, "arbitre indisponible"); assert.equal(d3.decisions.length, 0);
});

test("decide : 1 contre 1, un seul modèle, aucun modèle", async () => {
  const two = new FakeRouter([ballot("a", [vote(CAND.id, "OPEN")]), ballot("b", [vote(CAND.id, "HOLD")])]);
  assert.equal((await decide({ router: two, dossier: dossier(), portfolio: initialPortfolio(), now: NOW })).records[0].via, "1 contre 1");
  // un seul modèle : il peut fermer une position, pas en ouvrir
  const p = openHl(initialPortfolio(), { coin: "ETH", side: "long", usd: 100 }, { asks: [[50, 10]], bids: [[49.9, 10]] }, NOW).portfolio;
  const single = new FakeRouter([ballot("a", [vote(CAND.id, "OPEN", 95), vote("hl-1", "CLOSE")])]);
  const d = await decide({ router: single, dossier: dossier(), portfolio: p, now: NOW });
  assert.equal(d.mode, "single"); assert.deepEqual(d.decisions.map((x) => x.action), ["CLOSE"]);
  const none = await decide({ router: new FakeRouter([]), dossier: dossier(), portfolio: p, now: NOW });
  assert.equal(none.mode, "fallback"); assert.equal(none.decisions.length, 0);
  assert.equal(tallyCandidate("x", []).status, "no_quorum");
});

test("wakeReasons : seuil, proximité du stop, revue quotidienne une fois par jour", () => {
  const p = initialPortfolio();
  assert.deepEqual(wakeReasons({ dossier: { wakeLLM: false }, portfolio: p, now: NOW }), []);
  assert.deepEqual(wakeReasons({ dossier: { wakeLLM: true }, portfolio: p, now: NOW }), ["candidat au-dessus du seuil"]);
  const at14 = Date.UTC(2026, 10, 24, 14, 5);
  assert.deepEqual(wakeReasons({ dossier: {}, portfolio: p, now: at14 }), ["revue quotidienne"]);
  assert.deepEqual(wakeReasons({ dossier: {}, portfolio: { ...p, lastReviewDay: "2026-11-24" }, now: at14 }), []);
  const q = { venue: "hl", coin: "BTC", entryPx: 100, stopPx: 96, mark: 100 };
  assert.equal(nearStop(q, { BTC: { mark: 97 } }), true); assert.equal(nearStop(q, { BTC: { mark: 98 } }), false);
});

/* ---------- exécution ---------- */

const deep = (px, sz = 1e6) => ({ asks: [[px, sz]], bids: [[px * 0.999, sz]] });
const deps = (books) => ({ fetchL2Book: async (c) => books[c], fetchBook: async (t) => books[t] });

test("executeDecisions : taille du moteur de risque, stop, métadonnées du vote", async () => {
  const d = [{ id: CAND.id, action: "OPEN", via: "unanimité", conviction: 100, horizonH: 72, invalidation: "sous 96" }];
  const r = await executeDecisions(initialPortfolio(), d, dossier(), { markets: { BTC: { mark: 100 } }, deps: deps({ BTC: deep(100) }), now: NOW });
  const q = r.portfolio.positions[0];
  close(q.entryUsd, 3750); close(q.stopPx, 96); assert.equal(q.candidateId, CAND.id); assert.equal(q.invalidation, "sous 96"); assert.equal(q.horizonH, 72);
  assert.equal(r.trades[0].decision, "unanimité");
  // en mode reduceOnly : refus du moteur de risque, rien n'est exécuté
  const rr = await executeDecisions({ ...initialPortfolio(), equity: 7_900, peakEquity: 10_000 }, d, dossier(), { markets: { BTC: { mark: 100 } }, deps: deps({ BTC: deep(100) }), now: NOW });
  assert.equal(rr.trades.length, 0); assert.match(rr.refused[0].reason, /reduceOnly/);
});

test("executeDecisions : Polymarket au meilleur ask, paire, jambe orpheline refermée, fermeture votée", async () => {
  const pmC = { id: "pm|c1|Yes", type: "whale", venue: "pm", cid: "c1", token: "t1", outcome: "Yes", title: "T", pocket: "core", score: 2, metrics: { price: 0.4 } };
  const pair = { id: "pair|BTC|ETH", type: "pair", venue: "hl", pocket: "core", long: { coin: "BTC" }, short: { coin: "ETH" }, score: 2,
    metrics: { long_leg: { coin: "BTC", mark: 100, atr14: 2 }, short_leg: { coin: "ETH", mark: 50, atr14: 1 } } };
  const ds = dossier([pmC, pair]), mk = { BTC: { mark: 100 }, ETH: { mark: 50 } };
  const dec = [{ id: pmC.id, action: "OPEN", conviction: 100 }, { id: pair.id, action: "OPEN", conviction: 100 }];
  const r = await executeDecisions(initialPortfolio(), dec, ds, { markets: mk, deps: deps({ t1: { asks: [[0.4, 1e5]], bids: [[0.39, 1e5]] }, BTC: deep(100), ETH: deep(50) }), now: NOW });
  assert.deepEqual(r.portfolio.positions.map((q) => `${q.venue}:${q.coin || q.token}:${q.side || ""}`), ["pm:t1:", "hl:BTC:long", "hl:ETH:short"]);
  close(r.portfolio.positions[0].cost, 150); close(r.portfolio.positions[1].entryUsd, 1875, 1e-3);
  // jambe short sans profondeur : la jambe long est refermée aussitôt
  const thin = { asks: [[50, 1e6]], bids: [[50, 0.01]] };
  const o = await executeDecisions(initialPortfolio(), [dec[1]], ds, { markets: mk, deps: deps({ BTC: deep(100), ETH: thin }), now: NOW });
  assert.equal(o.portfolio.positions.length, 0); assert.equal(o.trades.at(-1).reason, "jambe orpheline"); assert.match(o.refused[0].reason, /liquidité/);
  // fermeture votée
  const c = await executeDecisions(r.portfolio, [{ id: "hl-2", action: "CLOSE", via: "2/3 votes" }], ds, { markets: mk, deps: deps({ BTC: deep(100) }), now: NOW });
  assert.equal(c.trades[0].type, "close"); assert.equal(c.trades[0].reason, "vote"); assert.equal(c.portfolio.positions.length, 2);
});

test("LLMRouter : erreurs avec le début du corps (modèle retiré, réponse non JSON)", async () => {
  const gone = '{"error":{"message":"The model `qwen/qwen3-32b` has been decommissioned","type":"invalid_request_error","code":"model_decommissioned"}}';
  const f = fakeFetch((model) => (model === "D" ? new Response(gone, { status: 404 }) : model === "E" ? new Response("OK\r\n", { status: 200, headers: { "content-type": "text/plain" } }) : new Response("", { status: 503 })));
  const r = new LLMRouter({ env: { K3: "k" }, providers: [PROVIDERS[2]], fetch: f });
  const out = await r.collect(3, [], (j) => ({ ok: true, value: j }));
  assert.equal(out.results.length, 0);
  assert.match(out.errors[0], /^p3\/D : HTTP 404 : \{"error":\{"message":"The model `qwen\/qwen3-32b` has been decommissioned/);
  assert.equal(out.errors[1], "p3/E : réponse non JSON (HTTP 200) : OK");
  assert.equal(out.errors[2], "p3/F : HTTP 503 : (corps vide)");
  assert.ok(out.errors[0].length <= "p3/D : HTTP 404 : ".length + 200);
});

test("DEFAULT_PROVIDERS : GitHub Models retiré, Groq sur des modèles en service, 3 familles", async () => {
  const { DEFAULT_PROVIDERS } = await import("../../lib/paper/router.mjs");
  assert.ok(!DEFAULT_PROVIDERS.some((p) => p.name === "github" || /models\.github\.ai/.test(p.url)));
  const groq = DEFAULT_PROVIDERS.find((p) => p.name === "groq");
  assert.ok(!groq.models.some((m) => ["llama-3.3-70b-versatile", "qwen/qwen3-32b"].includes(m.id)));
  assert.equal(new Set(groq.models.map((m) => m.family)).size, 3);
  assert.deepEqual(new LLMRouter({ env: { GROQ_API_KEY: "k", GITHUB_TOKEN: "t" }, fetch: async () => null }).available().map((x) => x.provider), ["groq", "groq", "groq", "groq"]);
});
