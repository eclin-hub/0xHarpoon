// Quota par minute de Groq (8 000 tokens, entrée + max_tokens) : dossier des votants ≤ 2 500 tokens, réponse ≤ 1 400 tokens ;
// options propres au modèle retirées si le serveur les refuse ; routage d'openrouter/free par le champ « models ».
import { test } from "node:test";
import assert from "node:assert/strict";
import { userPrompt, estimateTokens, PROMPT_BUDGET, SYSTEM_PROMPT, X_RULES, REGIME_RULES, positionsView } from "../../lib/paper/decision.mjs";
import { LLMRouter, DEFAULT_PROVIDERS, withDiscovered, discoverOpenRouter } from "../../lib/paper/router.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 10, 28, 12);
const cid = (k) => "0x" + String(k).repeat(64).slice(0, 64);
const cand = (k) => ({ id: `leadlag|${cid(k)}|Yes`, type: "leadlag", venue: "hl", coin: "BTC", side: "short", category: "crypto", pocket: "core", score: 3.14159,
  metrics: { pm_title: "Will the price of Bitcoin be above $60,000 on November 29? A very long market title that keeps going on and on", pm_outcome: "Yes", pm_move: -0.1, pm_price_start: 0.36512, pm_price: 0.26498, window_min: 105, asset_move: -0.0071234, reaction_needed: -0.0122345, atr_pct: 0.048912, mark: 59190.123 } });
const xCtx = Object.fromEntries(["BTC", "ETH", "SOL", "HYPE", "ZEC", "NVDA", "SOXL", "BRENTOIL"].map((t) => [t, { mentionVelocityRatio: 20.123456, netNarrativeBias: -0.0456, squeezeWarning: false, expires_in_min: 220,
  catalysts: [1, 2, 3].map((i) => ({ text: `BREAKING: a long catalyst headline number ${i} about ${t} with many words that the model does not really need to vote`.repeat(2), author: "WatcherGuru", age_min: 30 })) }]));
const regime = { regime: "RANGE_COMPRESSION", label: "Range", reasons: ["pas de tendance"], next_event: null, min_conviction: null, size_multiplier: 1, strategy_families_cut: [] };

test("dossier des votants : ≤ 2 500 tokens avec le système, métriques citables gardées, flux ε résumé ; coupe progressive au-delà", () => {
  const sys = SYSTEM_PROMPT + X_RULES + REGIME_RULES;
  const pf = { ...initialPortfolio(), positions: [] };
  const small = userPrompt({ candidates: [cand(1), cand(2)] }, pf, [], xCtx, regime, { system: sys });
  assert.ok(estimateTokens(sys) + estimateTokens(small) <= PROMPT_BUDGET, String(estimateTokens(sys) + estimateTokens(small)));
  const j = JSON.parse(small);
  assert.equal(j.candidates[0].metrics.pm_price, 0.265); assert.equal(j.candidates[0].metrics.mark, 59190);   // nombres arrondis, noms gardés
  assert.ok(j.candidates[0].metrics.pm_title.length <= 70); assert.equal(j.candidates[0].category, undefined);
  assert.equal(j.x_epsilon.BTC.mentionVelocityRatio, 20.123); assert.equal(j.x_epsilon.BTC.catalysts, undefined);   // résumé : pas de liste de titres
  assert.equal(j.macro_regime.regime, "RANGE_COMPRESSION");
  // dossier chargé (10 candidats, 9 positions) : coupes successives jusqu'au budget
  const big = { candidates: Array.from({ length: 10 }, (_, k) => cand(k)) };
  const pos = Array.from({ length: 9 }, (_, k) => ({ id: `hl-${k}`, venue: "hl", pocket: "core", coin: "ETH", side: "long", opened_hours_ago: 12.3456, horizon_hours: 48,
    invalidation: "Retour sous le prix d'entrée des baleines avec un funding qui redevient fortement négatif sur plusieurs heures", metrics: { entry: 1650.12345, mark: 1660.98765, pnl_pct: 0.006543, stop: 1600.5, dist_to_stop_pct: 0.0377, funding_paid_usd: 0.1234 } }));
  const full = userPrompt(big, pf, pos, xCtx, regime, { system: sys });
  assert.ok(estimateTokens(sys) + estimateTokens(full) <= PROMPT_BUDGET + 150, String(estimateTokens(sys) + estimateTokens(full)));   // au plus près du budget
  const f = JSON.parse(full);
  assert.equal(f.candidates.length, 10); assert.equal(f.open_positions.length, 9);                       // aucun candidat ni position retiré
  assert.ok(f.open_positions.every((p) => p.metrics.dist_to_stop_pct != null));
  assert.equal(f.open_positions[0].invalidation, undefined);                                             // invalidations retirées en dernier recours
  assert.equal(positionsView(initialPortfolio()).length, 0);
});

test("Groq : réponse plafonnée à 1 400 tokens, gpt-oss en raisonnement court ; option refusée (HTTP 400) → requête sans elle", async () => {
  const sent = [];
  const f = async (url, init) => { const b = JSON.parse(init.body); sent.push(b);
    if (b.reasoning_effort) return new Response('{"error":{"message":"reasoning_effort is not supported"}}', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }); };
  const r = new LLMRouter({ env: { GROQ_API_KEY: "g" }, fetch: f });
  const out = await r.collectAll([], (j) => ({ ok: true, value: j }));
  assert.equal(out.results.length, 2);
  const g = sent.filter((b) => b.model === "openai/gpt-oss-120b");
  assert.equal(g.length, 2); assert.equal(g[0].reasoning_effort, "low"); assert.equal(g[1].reasoning_effort, undefined);
  assert.deepEqual(g[1].response_format, { type: "json_object" });                                       // le mode JSON reste
  assert.ok(sent.every((b) => b.max_tokens === 1400));
  // budget par appel : 2 500 (dossier) + 1 400 (réponse) < 8 000 tokens/min
  assert.ok(PROMPT_BUDGET + DEFAULT_PROVIDERS.find((p) => p.name === "groq").maxTokens < 8000 / 2);
});

test("openrouter/free : champ « models » avec les 3 meilleurs :free du catalogue (Gemma et Ernie exclus) ; sans liste, inchangé", async () => {
  const M = (id, created, json = true) => ({ id, created, pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: json ? ["response_format"] : [] });
  const cat = { data: [M("google/gemma-4-31b-it:free", 9), M("google/gemma-4-26b-a4b-it:free", 9), M("baidu/ernie-5.5-flash-preview:free", 9), M("particle-ai/particle-1:free", 8),
    M("recursive/flint-v1.0:free", 7), M("nvidia/nemotron-3.5-super-vl:free", 6), M("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", 5, false), M("acme/zeta:free", 4)] };
  const d = await discoverOpenRouter({ fetch: async () => new Response(JSON.stringify(cat), { status: 200 }), now: NOW });
  assert.deepEqual(d.routing, ["particle-ai/particle-1:free", "recursive/flint-v1.0:free", "nvidia/nemotron-3.5-super-vl:free"]);
  assert.deepEqual(d.models.map((m) => m.id), ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"]);   // votant : ≥ 24 Md, taille connue
  assert.deepEqual(d.cache.routing, d.routing);
  const r = new LLMRouter({ env: { OPENROUTER_API_KEY: "o" }, providers: withDiscovered(DEFAULT_PROVIDERS, d.models, d.routing) });
  const body = r.request(r.entries.find((e) => e.model === "openrouter/free"), [], true).body;
  assert.equal(body.model, "particle-ai/particle-1:free"); assert.deepEqual(body.models, d.routing);
  const plain = new LLMRouter({ env: { OPENROUTER_API_KEY: "o" }, providers: withDiscovered(DEFAULT_PROVIDERS, [], []) });
  const pb = plain.request(plain.entries.find((e) => e.model === "openrouter/free"), [], true).body;
  assert.equal(pb.model, "openrouter/free"); assert.equal(pb.models, undefined);
});
