// Routeur LLM multi-fournisseurs gratuits (SPEC §4.1). Tous parlent le format « chat completions » d'OpenAI.
// Ordre : Groq, Cerebras, SambaNova, OpenRouter (:free), Gemini. Un fournisseur sans clé est ignoré.
// GitHub Models n'y figure plus : le service a été entièrement retiré le 30 juillet 2026 (models.github.ai répond
// désormais « OK » en texte brut à toute requête).
// Chaque modèle a une « famille » : deux votants ne peuvent pas être de la même famille (gpt-oss 120b et 20b comptent
// pour un seul modèle), et l'arbitre doit être d'une famille différente des votants : avec Groq seul (3 familles),
// il n'y a pas d'arbitre et un vote à 2 contre 1 n'ouvre rien ; une clé d'un autre fournisseur en apporte un.
// Les identifiants de modèles changent souvent : la liste se remplace sans toucher au code avec la variable
// d'environnement PAPER_LLM_PROVIDERS (même format JSON que DEFAULT_PROVIDERS).
import { extractJson } from "./schema.mjs";

export const DEFAULT_PROVIDERS = [
  // Groq, modèles en service au 24/11/2026 (llama-3.3-70b-versatile arrêté le 16/08/2026, qwen/qwen3-32b le 17/07/2026)
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", models: [
    { id: "openai/gpt-oss-120b", family: "gpt-oss" },
    { id: "qwen/qwen3.8-27b", family: "qwen3.8" },
    { id: "llama-3.1-8b-instant", family: "llama-3.1" },
    { id: "openai/gpt-oss-20b", family: "gpt-oss" },
  ] },
  { name: "cerebras", url: "https://api.cerebras.ai/v1/chat/completions", keyEnv: "CEREBRAS_API_KEY", models: [
    { id: "llama-3.3-70b", family: "llama-3.3-70b" }, { id: "qwen-3-32b", family: "qwen3-32b" },
  ] },
  { name: "sambanova", url: "https://api.sambanova.ai/v1/chat/completions", keyEnv: "SAMBANOVA_API_KEY", models: [
    { id: "Meta-Llama-3.3-70B-Instruct", family: "llama-3.3-70b" }, { id: "DeepSeek-V3-0324", family: "deepseek-v3" },
  ] },
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY", models: [
    { id: "deepseek/deepseek-chat-v3-0324:free", family: "deepseek-v3" }, { id: "meta-llama/llama-3.3-70b-instruct:free", family: "llama-3.3-70b" },
  ] },
  { name: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY", models: [
    { id: "gemini-2.0-flash", family: "gemini-flash" },
  ] },
];

export class LLMRouter {
  // env : variables d'environnement (clés) ; fetch injectable pour les tests
  constructor({ env = process.env, providers = null, fetch: f = globalThis.fetch, timeoutMs = 60_000 } = {}) {
    const list = providers ?? (env.PAPER_LLM_PROVIDERS ? JSON.parse(env.PAPER_LLM_PROVIDERS) : DEFAULT_PROVIDERS);
    this.entries = list.flatMap((p) => (env[p.keyEnv] ? p.models.map((m) => ({ provider: p.name, url: p.url, key: env[p.keyEnv], model: m.id, family: m.family })) : []));
    this.fetch = f; this.timeoutMs = timeoutMs; this.failed = new Set(); this.log = [];
  }
  available() { return this.entries.map(({ provider, model, family }) => ({ provider, model, family })); }

  async call(e, messages) {
    const send = (json) => this.fetch(e.url, {
      method: "POST", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${e.key}` },
      // max_tokens 4000 : marge pour les modèles qui raisonnent avant de répondre (gpt-oss)
      body: JSON.stringify({ model: e.model, messages, temperature: 0.2, max_tokens: 4000, ...(json ? { response_format: { type: "json_object" } } : {}) }),
    });
    let r = await send(true);
    if (r.status === 400) r = await send(false);   // certains modèles gratuits refusent le mode JSON
    const raw = await r.text(), excerpt = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    // le début du corps dit pourquoi (modèle retiré ou renommé, quota, clé…), au lieu d'un simple code HTTP
    if (!r.ok) throw new Error(`HTTP ${r.status} : ${excerpt || "(corps vide)"}`);
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error(`réponse non JSON (HTTP ${r.status}) : ${excerpt || "(corps vide)"}`); }
    const text = body?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`réponse sans contenu : ${excerpt}`);
    return extractJson(text);
  }

  // Obtient n réponses valides de familles distinctes. validate(json) → { ok, value?, error? }.
  // Les appels d'une vague partent en parallèle ; un échec (réseau, limite, JSON invalide) passe au modèle suivant.
  async collect(n, messages, validate, { excludeFamilies = [] } = {}) {
    const used = new Set(excludeFamilies), results = [], errors = [];
    const queue = this.entries.filter((e) => !this.failed.has(e.provider + "/" + e.model));
    while (results.length < n) {
      const wave = [];
      for (const e of queue) {
        if (wave.length >= n - results.length) break;
        if (used.has(e.family) || wave.some((w) => w.family === e.family) || e.tried) continue;
        wave.push(e);
      }
      if (!wave.length) break;
      const out = await Promise.all(wave.map(async (e) => {
        e.tried = true;
        const t0 = Date.now();
        try {
          const v = validate(await this.call(e, messages));
          this.log.push({ provider: e.provider, model: e.model, ms: Date.now() - t0, ok: v.ok, error: v.ok ? null : v.error });
          return v.ok ? { e, value: v.value } : { e, error: `réponse invalide : ${v.error}` };
        } catch (err) {
          this.failed.add(e.provider + "/" + e.model);
          this.log.push({ provider: e.provider, model: e.model, ms: Date.now() - t0, ok: false, error: String(err.message || err) });
          return { e, error: String(err.message || err) };
        }
      }));
      for (const o of out) {
        if (o.value !== undefined && !used.has(o.e.family)) { used.add(o.e.family); results.push({ provider: o.e.provider, model: o.e.model, family: o.e.family, value: o.value }); }
        else if (o.error) errors.push(`${o.e.provider}/${o.e.model} : ${o.error}`);
      }
    }
    for (const e of queue) delete e.tried;
    return { results, errors };
  }
}
