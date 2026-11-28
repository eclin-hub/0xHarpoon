// Découverte des modèles gratuits d'OpenRouter (router.mjs : selectFreeModels, discoverOpenRouter, withDiscovered) et
// délai par fournisseur. Le catalogue de test reprend la forme et les cas réels du 28/11/2026 (GET /api/v1/models).
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFreeModels, discoverOpenRouter, withDiscovered, openrouterFamily, DEFAULT_PROVIDERS, OPENROUTER_CFG, LLMRouter } from "../../lib/paper/router.mjs";
import { errorCode } from "../../lib/paper/llm_ranking.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3, iso = (t) => new Date(t).toISOString();
const t = (d) => Math.floor(Date.UTC(2026, 9, d) / 1000);   // date de création (secondes)
const M = (id, o = {}) => ({ id, name: id, created: o.created ?? t(1), pricing: o.pricing ?? { prompt: id.endsWith(":free") ? "0" : "0.000001", completion: id.endsWith(":free") ? "0" : "0.000002" },
  architecture: { input_modalities: o.input ?? ["text"], output_modalities: o.output ?? ["text"] }, supported_parameters: o.json === false ? ["temperature"] : ["temperature", "response_format"],
  ...(o.expires ? { expiration_date: o.expires } : {}) });
const CATALOG = { data: [
  M("particle-ai/particle-1:free", { created: t(28), input: ["text", "image"] }),
  M("recursive/flint-v1.0:free", { created: t(21) }),
  M("nvidia/nemotron-3.5-super-vl:free", { created: t(15), input: ["text", "image", "video"] }),
  M("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", { created: t(20), json: false }),         // même famille que la précédente
  M("nvidia/nemotron-3.5-lightning:free", { created: t(30) }),                                        // liste noire (réponses vides)
  M("nvidia/nemotron-3-ultra-550b-a55b:free", { created: t(30) }),                                    // liste noire (60 s)
  M("liquid/lfm-3-1.7b:free", { created: t(29) }),                                                    // trop petit (< 7 Md)
  M("google/gemma-4-26b-a4b-it:free", { created: t(29) }),                                            // même famille que 31b, plus petit
  M("google/gemma-4-31b-it:free", { created: t(2) }),                                                 // 31 Md, mode JSON
  M("baidu/ernie-5.5-flash-preview:free", { created: t(29) }),                                        // taille inconnue
  M("google/lyria-3-pro-preview", { created: t(29), pricing: { prompt: "0", completion: "0" }, output: ["text", "audio"] }),   // sortie audio
  M("openai/gpt-oss-120b:free", { created: t(29) }),                                                  // déjà sur Groq
  M("qwen/qwen3.8-27b:free", { created: t(29) }),                                                     // déjà sur Groq
  M("deepseek/deepseek-v4-pro-671b:free", { created: t(29) }),                                        // déjà chez DeepSeek
  M("acme/old-model-70b:free", { created: t(29), expires: iso(NOW - H) }),                            // expiré
  M("openrouter/free", { created: t(1), pricing: { prompt: "0", completion: "0" } }),                // déjà fixe
  M("mistralai/mistral-large", { created: t(29) }),                                                   // payant
  M("deepcogito/cogito-v3-70b", { created: t(2), pricing: { prompt: "0", completion: "0" } }),       // gratuit par le prix, sans « :free »
] };

test("catalogue :free : 1 modèle d'au moins 24 Md (taille connue), gratuit, texte, pas expiré ; familles du socle, liste noire et petits exclus", () => {
  const sel = selectFreeModels(CATALOG, DEFAULT_PROVIDERS, { now: NOW });
  assert.deepEqual(sel.map((m) => m.id), ["deepcogito/cogito-v3-70b"]);                                // JSON, puis le plus gros
  assert.equal(sel[0].params, 70); assert.ok(sel[0].family.startsWith("or:"));
  assert.equal(OPENROUTER_CFG.max, 1); assert.equal(OPENROUTER_CFG.minParamsB, 24);
  // sans limite : JSON d'abord, plus gros d'abord ; une version par famille (gemma 31b, pas 26b) ; jamais les exclus
  const all = selectFreeModels(CATALOG, DEFAULT_PROVIDERS, { now: NOW, cfg: { ...OPENROUTER_CFG, max: 10 } }).map((m) => m.id);
  assert.deepEqual(all, ["deepcogito/cogito-v3-70b", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"]);   // Gemma 4 gratuit exclu (pool saturé)
  for (const bad of ["particle-ai/particle-1:free", "recursive/flint-v1.0:free", "nvidia/nemotron-3.5-super-vl:free", "baidu/ernie-5.5-flash-preview:free",   // taille inconnue
    "liquid/lfm-3-1.7b:free", "google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free", "google/lyria-3-pro-preview", "openai/gpt-oss-120b:free", "qwen/qwen3.8-27b:free",
    "deepseek/deepseek-v4-pro-671b:free", "acme/old-model-70b:free", "openrouter/free", "mistralai/mistral-large", "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free"]) assert.ok(!all.includes(bad), bad);
  // catalogue réel du 28/11/2026 (sans cogito, Gemma exclu) : seul nemotron-3-nano-omni 30B reste au-dessus de 24 Md
  const real = { data: CATALOG.data.filter((m) => !m.id.startsWith("deepcogito")) };
  assert.deepEqual(selectFreeModels(real, DEFAULT_PROVIDERS, { now: NOW }).map((m) => m.id), ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"]);
  assert.equal(openrouterFamily("nvidia/nemotron-3.5-super-vl:free"), "nvidia/nemotron");
  assert.deepEqual(selectFreeModels({}, DEFAULT_PROVIDERS), []); assert.deepEqual(selectFreeModels(null), []);
});

test("découverte : catalogue gardé 6 h ; réseau en panne → dernière liste gardée, sans exception ; ajout au fournisseur OpenRouter", async () => {
  let calls = 0;
  const f = async (url) => { calls++; assert.equal(url, OPENROUTER_CFG.url); return new Response(JSON.stringify(CATALOG), { status: 200 }); };
  const a = await discoverOpenRouter({ fetch: f, now: NOW });
  assert.equal(a.source, "réseau"); assert.equal(a.models.length, 1); assert.equal(a.cache.catalogSize, CATALOG.data.length); assert.equal(calls, 1);
  const b = await discoverOpenRouter({ fetch: f, cache: JSON.parse(JSON.stringify(a.cache)), now: NOW + 5 * H });
  assert.equal(b.source, "cache"); assert.equal(calls, 1);
  const down = async () => { throw new Error("getaddrinfo ENOTFOUND openrouter.ai"); };
  const c = await discoverOpenRouter({ fetch: down, cache: a.cache, now: NOW + 7 * H });
  assert.equal(c.source, "cache périmé"); assert.equal(c.models.length, 1); assert.match(c.error, /catalogue OpenRouter : getaddrinfo/);
  const d = await discoverOpenRouter({ fetch: async () => new Response("rate limited", { status: 429 }), now: NOW });
  assert.equal(d.source, "aucun"); assert.deepEqual(d.models, []); assert.match(d.error, /HTTP 429/);
  assert.equal((await discoverOpenRouter({ fetch: f, net: false, now: NOW })).source, "aucun");
  // ajout au fournisseur OpenRouter, sans doublon ; les autres fournisseurs intacts
  const P = withDiscovered(DEFAULT_PROVIDERS, [...a.models, { id: "openrouter/free", family: "x" }]);
  const or = P.find((p) => p.name === "openrouter");
  assert.deepEqual(or.models.map((m) => m.id), ["openrouter/free", ...a.models.map((m) => m.id)]);
  assert.deepEqual(P.filter((p) => p.name !== "openrouter"), DEFAULT_PROVIDERS.filter((p) => p.name !== "openrouter"));
  // routeur : sans clé OpenRouter, aucun modèle découvert n'est appelé ; avec la clé, ils votent
  assert.ok(!new LLMRouter({ env: { GROQ_API_KEY: "g" }, providers: P }).available().some((m) => m.provider === "openrouter"));
  assert.ok(new LLMRouter({ env: { OPENROUTER_API_KEY: "o" }, providers: P }).available().some((m) => m.model === "deepcogito/cogito-v3-70b"));
});

test("délai par fournisseur (OpenRouter 60 s) ; 402 abonnement reconnu", async () => {
  const seen = [];
  const f = async (url, init) => { seen.push([url, init.signal]); return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }); };
  const providers = [{ name: "lent", url: "https://slow.test/v1", keyEnv: "S", timeoutMs: 60_000, models: [{ id: "a", family: "a", role: "voter" }] },
    { name: "rapide", url: "https://fast.test/v1", keyEnv: "F", models: [{ id: "b", family: "b", role: "voter" }] }];
  const r = new LLMRouter({ env: { S: "s", F: "f" }, providers, fetch: f, timeoutMs: 5_000 });
  assert.deepEqual(r.entries.map((e) => [e.model, e.timeoutMs]), [["a", 60_000], ["b", null]]);
  const out = await r.collectAll([], (j) => ({ ok: true, value: j }));
  assert.equal(out.results.length, 2);
  assert.equal(errorCode('HTTP 402 : {"message":"You need a subscription to access this API.","type":"billing_no_api_budget_configured"}'), "402 abonnement");
});
