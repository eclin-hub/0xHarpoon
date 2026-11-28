// Réponses vides de DeepSeek, mode JSON de gpt-oss sur Groq, cause exacte des échecs, cache OpenRouter avec un modèle refusé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LLMRouter, DEFAULT_PROVIDERS, discoverOpenRouter } from "../../lib/paper/router.mjs";
import { errorCode } from "../../lib/paper/llm_ranking.mjs";

const NOW = Date.UTC(2026, 10, 28, 12);
const ok = (message, extra = {}) => new Response(JSON.stringify({ choices: [{ message, ...extra }] }), { status: 200 });
const only = (id) => DEFAULT_PROVIDERS.map((p) => ({ ...p, models: p.models.filter((m) => m.id === id) })).filter((p) => p.models.length);
const MSG = [{ role: "system", content: "Vote on the candidates." }, { role: "user", content: "{}" }];

test("DeepSeek : content vide → JSON extrait de reasoning_content ; mot « json » ajouté au prompt système avec response_format ; 8 000 tokens", async () => {
  const sent = [];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body));
    return ok({ role: "assistant", content: "", reasoning_content: 'The user wants a vote. I will answer {"action":"HOLD","conviction":40} as final.' }); };
  const r = new LLMRouter({ env: { DEEPSEEK_API_KEY: "k" }, providers: only("deepseek-flash"), fetch });
  assert.deepEqual(await r.call(r.entries[0], MSG), { action: "HOLD", conviction: 40 });
  assert.deepEqual(sent[0].response_format, { type: "json_object" }); assert.equal(sent[0].max_tokens, 8000);
  assert.match(sent[0].messages[0].content, /^Vote on the candidates\.\nAnswer with a single valid JSON object\.$/);
  assert.equal(MSG[0].content, "Vote on the candidates.");   // messages d'origine intacts
  // prompt qui parle déjà de JSON : inchangé
  const plain = new LLMRouter({ env: { DEEPSEEK_API_KEY: "k" }, providers: only("deepseek-flash") });
  assert.equal(plain.request(plain.entries[0], [{ role: "system", content: "Answer in JSON only." }], true).body.messages[0].content, "Answer in JSON only.");
  // vide sans JSON dans le raisonnement, réponse tronquée : cause explicite
  const cut = new LLMRouter({ env: { DEEPSEEK_API_KEY: "k" }, providers: only("deepseek-flash"), fetch: async () => ok({ content: "", reasoning_content: "thinking…" }, { finish_reason: "length" }) });
  await assert.rejects(cut.call(cut.entries[0], MSG), /réponse tronquée \(finish_reason length, max_tokens 8000/);
  assert.equal(errorCode("réponse tronquée (finish_reason length, max_tokens 8000 épuisé par le raisonnement)"), "réponse tronquée");
});

test("DeepSeek : identifiant refusé (404 ou 400 « Model Not Exist ») → repli deepseek-chat / deepseek-reasoner", async () => {
  for (const [id, alias, deny] of [["deepseek-flash", "deepseek-chat", new Response("Not Found", { status: 404 })], ["deepseek-v4-pro", "deepseek-reasoner", new Response('{"error":{"message":"Model Not Exist"}}', { status: 400 })]]) {
    const models = [];
    const fetch = async (url, init) => { const b = JSON.parse(init.body); models.push(b.model); return b.model === id ? deny.clone() : ok({ content: '{"ok":true}' }); };
    const r = new LLMRouter({ env: { DEEPSEEK_API_KEY: "k" }, providers: only(id), fetch });
    assert.deepEqual(await r.call(r.entries[0], MSG), { ok: true });
    assert.deepEqual(models, [id, alias]); assert.equal(r.entries[0].resolvedModel, alias);
  }
  // autre 400 (pas un problème d'identifiant) : pas de repli d'alias
  const models = [];
  const r = new LLMRouter({ env: { DEEPSEEK_API_KEY: "k" }, providers: only("deepseek-flash"), fetch: async (u, init) => { models.push(JSON.parse(init.body).model); return new Response('{"error":{"message":"Invalid max_tokens"}}', { status: 400 }); } });
  await assert.rejects(r.call(r.entries[0], MSG), /HTTP 400 : .*Invalid max_tokens/);
  assert.ok(models.every((m) => m === "deepseek-flash"));
});

test("Groq gpt-oss-120b : jamais de response_format, bloc {...} extrait de la réponse texte ; qwen3.8 garde le mode JSON", async () => {
  const sent = [];
  const fetch = async (url, init) => { const b = JSON.parse(init.body); sent.push(b); return ok({ content: 'Let me think. Final answer:\n```json\n{"action":"BUY","conviction":72}\n```' }); };
  const r = new LLMRouter({ env: { GROQ_API_KEY: "g" }, providers: only("openai/gpt-oss-120b"), fetch });
  assert.deepEqual(await r.call(r.entries[0], MSG), { action: "BUY", conviction: 72 });
  assert.equal(sent.length, 1); assert.equal(sent[0].response_format, undefined); assert.equal(sent[0].reasoning_effort, "low");
  assert.equal(sent[0].messages[0].content, MSG[0].content);   // pas de consigne JSON ajoutée sans response_format
  const q = new LLMRouter({ env: { GROQ_API_KEY: "g" }, providers: only("qwen/qwen3.8-27b") });
  assert.deepEqual(q.request(q.entries[0], MSG, true).body.response_format, { type: "json_object" });
});

test("cause exacte des échecs : code HTTP au lieu de « erreur »", () => {
  assert.equal(errorCode('HTTP 400 : {"error":{"message":"Failed to validate JSON","code":"json_validate_failed"}}'), "400 JSON");
  assert.equal(errorCode('HTTP 400 : {"error":{"message":"Invalid max_tokens value"}}'), "400 requête");
  assert.equal(errorCode("HTTP 401 : invalid api key"), "401 clé");
  assert.equal(errorCode("HTTP 403 : forbidden"), "403 clé");
  assert.equal(errorCode("HTTP 500 : internal"), "500 serveur");
  assert.equal(errorCode("HTTP 418 : teapot"), "HTTP 418");
  assert.equal(errorCode("réponse sans contenu : {}"), "réponse vide");
  assert.equal(errorCode("quelque chose d'inattendu"), "quelque chose d'inattendu");
});

test("cache OpenRouter contenant google/gemma-4-31b-it:free : rafraîchi tout de suite et purgé, même frais", async () => {
  const cache = { at: new Date(NOW - 60e3).toISOString(), models: [{ id: "google/gemma-4-31b-it:free", family: "or:google/gemma" }], routing: ["google/gemma-4-31b-it:free", "acme/zeta:free"] };
  let calls = 0;
  const M = (id) => ({ id, created: 1, pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["response_format"] });
  const fetch = async () => { calls++; return new Response(JSON.stringify({ data: [M("google/gemma-4-31b-it:free"), M("acme/zeta-70b:free")] }), { status: 200 }); };
  const d = await discoverOpenRouter({ fetch, cache, now: NOW });
  assert.equal(calls, 1); assert.equal(d.source, "réseau");
  assert.ok(![...d.models.map((m) => m.id), ...d.routing].some((id) => /gemma-4/.test(id)));
  // sans réseau : le cache est relu, mais sans le modèle refusé
  const off = await discoverOpenRouter({ cache, now: NOW, net: false });
  assert.deepEqual(off.models, []); assert.deepEqual(off.routing, ["acme/zeta:free"]);
  // cache sain et frais : relu tel quel, sans appel
  const clean = { ...cache, models: [], routing: ["acme/zeta:free"] };
  assert.equal((await discoverOpenRouter({ fetch, cache: clean, now: NOW })).source, "cache"); assert.equal(calls, 1);
});
