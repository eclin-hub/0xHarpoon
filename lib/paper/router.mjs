// Routeur LLM multi-fournisseurs gratuits (SPEC §4.1). Tous parlent le format « chat completions » d'OpenAI.
// Ordre : Groq, Gemini (API directe Google AI Studio), puis Cerebras et SambaNova si leurs clés existent, et OpenRouter
// en simple secours (pool :free souvent saturé : HTTP 429, délais de 60 s). Un fournisseur sans clé est ignoré.
// GitHub Models n'y figure plus : le service a été entièrement retiré le 30 juillet 2026 (models.github.ai répond
// désormais « OK » en texte brut à toute requête).
// Chaque modèle a une « famille » : deux votants ne peuvent pas être de la même famille (gpt-oss 120b et 20b comptent
// pour un seul modèle), et l'arbitre doit être d'une famille différente des votants. Groq fournit 2 familles
// (gpt-oss, qwen3.8) et Gemini la 3e (votant) ; l'arbitre vient d'OpenRouter (gemma, ernie) quand son pool répond.
// Rôles (audit des 3 premiers jours) : `role: "voter"` ne vote que, `role: "arbiter"` n'arbitre que ; `shadowOnly: true`
// = poids nul : le modèle est interrogé à part (collectShadow), ses votes alimentent seulement le PnL contrefactuel,
// jamais le dépouillement ni l'exécution. Votants : gpt-oss-120b, qwen3.8, gemini-3.8-flash, ernie en remplaçant ;
// arbitre : gemma-4-26b-a4b-it.
// Les identifiants de modèles changent souvent : la liste se remplace sans toucher au code avec la variable
// d'environnement PAPER_LLM_PROVIDERS (même format JSON que DEFAULT_PROVIDERS).
import { extractJson } from "./schema.mjs";

export const DEFAULT_PROVIDERS = [
  // Groq, vérifié en réel le 24/11/2026 (~2,5 s) ; llama-3.3-70b-versatile, qwen/qwen3-32b et llama-3.1-8b-instant : 404
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", models: [
    { id: "openai/gpt-oss-120b", family: "gpt-oss", role: "voter" },
    { id: "qwen/qwen3.8-27b", family: "qwen3.8", role: "voter" },
    { id: "openai/gpt-oss-20b", family: "gpt-oss", role: "voter" },
  ] },
  // Gemini : 3e votant. gemini-2.0-flash arrêté le 01/06/2026 ; gemini-2.5-flash et 2.5-pro dépréciés (redirigés
  // à partir du 01/12/2026). 3.6-flash (−0,51 R, 0 % de réussite) et 3.5-flash-lite (−1,00 R) : ombre seulement (27/11/2026).
  { name: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY", models: [
    { id: "gemini-3.8-flash", family: "gemini", role: "voter" },
    { id: "gemini-3.6-flash", family: "gemini", shadowOnly: true }, { id: "gemini-3.5-flash-lite", family: "gemini", shadowOnly: true },
  ] },
  // Gemma 4 sur l'API Gemini, même clé : arbitre (4e famille) sans dépendre du pool gratuit d'OpenRouter.
  // Seuls ces deux modèles sont hébergés (doc Gemma, 24/11/2026). API native generateContent : l'endpoint compatible
  // OpenAI n'est pas documenté pour Gemma. Quota gratuit non précisé par la documentation.
  { name: "gemma", api: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/models", keyEnv: "GEMINI_API_KEY", models: [
    { id: "gemma-4-26b-a4b-it", family: "gemma", role: "arbiter" }, { id: "gemma-4-31b-it", family: "gemma", role: "arbiter" },
  ] },
  { name: "cerebras", url: "https://api.cerebras.ai/v1/chat/completions", keyEnv: "CEREBRAS_API_KEY", models: [
    { id: "llama-3.3-70b", family: "llama-3.3-70b", role: "voter" }, { id: "qwen-3-32b", family: "qwen3-32b", role: "voter" },
  ] },
  { name: "sambanova", url: "https://api.sambanova.ai/v1/chat/completions", keyEnv: "SAMBANOVA_API_KEY", models: [
    { id: "Meta-Llama-3.3-70B-Instruct", family: "llama-3.3-70b", role: "voter" }, { id: "DeepSeek-V3-0324", family: "deepseek-v3", role: "voter" },
  ] },
  // OpenRouter, secours seulement (compte gratuit, modèles :free). Cycle du 24/11/2026 : nemotron-3-ultra trop lent
  // (60 s), nemotron-3.5-lightning sans contenu (retirés) ; ernie remplace un votant absent, gemma un arbitre absent.
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY", models: [
    { id: "baidu/ernie-5.5-flash-preview:free", family: "ernie", role: "voter" },
    { id: "google/gemma-4-31b-it:free", family: "gemma", role: "arbiter" },
  ] },
];

export class LLMRouter {
  // env : variables d'environnement (clés) ; fetch injectable pour les tests
  constructor({ env = process.env, providers = null, fetch: f = globalThis.fetch, timeoutMs = 60_000 } = {}) {
    const list = providers ?? (env.PAPER_LLM_PROVIDERS ? JSON.parse(env.PAPER_LLM_PROVIDERS) : DEFAULT_PROVIDERS);
    this.entries = list.flatMap((p) => (env[p.keyEnv] ? p.models.map((m) => ({ provider: p.name, url: p.url, api: p.api || "openai", key: env[p.keyEnv], model: m.id, family: m.family, role: m.role ?? null, shadowOnly: !!m.shadowOnly })) : []));
    this.fetch = f; this.timeoutMs = timeoutMs; this.failed = new Set(); this.log = [];
  }
  // modèles qui comptent dans les décisions (les modèles « ombre » sont à part : shadowModels)
  available() { return this.entries.filter((e) => !e.shadowOnly).map(({ provider, model, family, role }) => ({ provider, model, family, role })); }
  shadowModels() { return this.entries.filter((e) => e.shadowOnly).map(({ provider, model, family }) => ({ provider, model, family })); }

  // Requête selon le format du fournisseur : « openai » (chat completions) ou « gemini » (generateContent natif de
  // Google, documenté pour Gemma ; clé dans l'en-tête x-goog-api-key, jamais dans l'URL).
  request(e, messages, json) {
    if (e.api === "gemini") {
      const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      return { url: `${e.url}/${encodeURIComponent(e.model)}:generateContent`, headers: { "content-type": "application/json", "x-goog-api-key": e.key },
        body: { ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
          contents: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { temperature: 0.2, maxOutputTokens: 4000, ...(json ? { responseMimeType: "application/json" } : {}) } } };
    }
    // max_tokens 4000 : marge pour les modèles qui raisonnent avant de répondre (gpt-oss)
    return { url: e.url, headers: { "content-type": "application/json", authorization: `Bearer ${e.key}` },
      body: { model: e.model, messages, temperature: 0.2, max_tokens: 4000, ...(json ? { response_format: { type: "json_object" } } : {}) } };
  }
  static textOf(e, body) {
    return e.api === "gemini"
      ? (body?.candidates?.[0]?.content?.parts || []).map((p) => (p.thought ? "" : p.text || "")).join("")
      : body?.choices?.[0]?.message?.content;
  }

  async call(e, messages) {
    const send = (json) => { const q = this.request(e, messages, json);
      return this.fetch(q.url, { method: "POST", signal: AbortSignal.timeout(this.timeoutMs), headers: q.headers, body: JSON.stringify(q.body) }); };
    let r = await send(true);
    if (r.status === 400) r = await send(false);   // certains modèles gratuits refusent le mode JSON
    const raw = await r.text(), excerpt = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    // le début du corps dit pourquoi (modèle retiré ou renommé, quota, clé…), au lieu d'un simple code HTTP
    if (!r.ok) throw new Error(`HTTP ${r.status} : ${excerpt || "(corps vide)"}`);
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error(`réponse non JSON (HTTP ${r.status}) : ${excerpt || "(corps vide)"}`); }
    const text = LLMRouter.textOf(e, body);
    if (!text) throw new Error(`réponse sans contenu : ${excerpt}`);
    return extractJson(text);
  }

  // Obtient n réponses valides de familles distinctes. validate(json) → { ok, value?, error? }.
  // Les appels d'une vague partent en parallèle ; un échec (réseau, limite, JSON invalide) passe au modèle suivant.
  // role : "voter" ou "arbiter" (les modèles sans rôle servent aux deux) ; les modèles shadowOnly n'y sont jamais.
  async collect(n, messages, validate, { excludeFamilies = [], role = null } = {}) {
    const used = new Set(excludeFamilies), results = [], errors = [];
    const queue = this.entries.filter((e) => !e.shadowOnly && (!role || !e.role || e.role === role) && !this.failed.has(e.provider + "/" + e.model));
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

  // Modèles « ombre » (poids nul) : tous interrogés en parallèle, sans contrainte de famille. Leurs réponses servent
  // uniquement au PnL contrefactuel par modèle.
  async collectShadow(messages, validate) {
    const list = this.entries.filter((e) => e.shadowOnly && !this.failed.has(e.provider + "/" + e.model)), results = [], errors = [];
    await Promise.all(list.map(async (e) => {
      const t0 = Date.now();
      try {
        const v = validate(await this.call(e, messages));
        this.log.push({ provider: e.provider, model: e.model, ms: Date.now() - t0, ok: v.ok, error: v.ok ? null : v.error, shadowOnly: true });
        if (v.ok) results.push({ provider: e.provider, model: e.model, family: e.family, value: v.value, shadowOnly: true });
        else errors.push(`${e.provider}/${e.model} : réponse invalide : ${v.error}`);
      } catch (err) {
        this.failed.add(e.provider + "/" + e.model);
        this.log.push({ provider: e.provider, model: e.model, ms: Date.now() - t0, ok: false, error: String(err.message || err), shadowOnly: true });
        errors.push(`${e.provider}/${e.model} : ${err.message || err}`);
      }
    }));
    return { results, errors };
  }
}
