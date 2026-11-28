// Routeur LLM multi-fournisseurs gratuits (SPEC §4.1). Tous parlent le format « chat completions » d'OpenAI.
// Ordre : Groq, Gemini (API directe Google AI Studio), puis Cerebras, Mistral et SambaNova si leurs clés existent, et
// OpenRouter (pool :free souvent saturé : HTTP 429, délais de 60 s). Un fournisseur sans clé est ignoré.
// Vote : collectAll interroge en parallèle TOUS les modèles décisionnels (non shadowOnly) ; leur poids vient du classement
// dynamique (llm_ranking.mjs, 4 % à 30 %). collect(n) reste pour les appels uniques (arbitre, régime, Blueprints).
// OpenRouter (palier gratuit) : 400 ms au moins entre deux requêtes vers openrouter.ai, même lancées en parallèle.
// GitHub Models n'y figure plus : le service a été entièrement retiré le 30 juillet 2026 (models.github.ai répond
// désormais « OK » en texte brut à toute requête).
// Chaque modèle a une « famille » : deux votants ne peuvent pas être de la même famille (gpt-oss 120b et 20b comptent
// pour un seul modèle), et l'arbitre doit être d'une famille différente des votants. Groq fournit 2 familles
// (gpt-oss, qwen3.8) et Gemini la 3e (votant) ; l'arbitre vient d'OpenRouter (gemma, ernie) quand son pool répond.
// Rôles (audit des 3 premiers jours) : `role: "voter"` ne vote que, `role: "arbiter"` n'arbitre que ; `shadowOnly: true`
// = poids nul : le modèle est interrogé à part (collectShadow), ses votes alimentent seulement le PnL contrefactuel,
// jamais le dépouillement ni l'exécution. Votants : gpt-oss-120b et qwen3.8 (Groq) ; arbitre : gemma-4-26b-a4b-it
// (gemma-4-31b-it en secours) ; ombre : gemini-3.8-flash (HTTP 429 en ~200 ms sur la clé AI Studio, 28/11/2026),
// gemini-3.5-flash-lite et ernie-5.5-flash-preview. Retiré le 28/11/2026 :
// gemini-3.6-flash (HTTP 429 immédiat, pas de quota sur la clé AI Studio) et gpt-oss-20b (remplaçant jamais utile).
// Les identifiants de modèles changent souvent : la liste se remplace sans toucher au code avec la variable
// d'environnement PAPER_LLM_PROVIDERS (même format JSON que DEFAULT_PROVIDERS).
import { extractJson } from "./schema.mjs";

export const DEFAULT_PROVIDERS = [
  // Groq, vérifié en réel le 24/11/2026 (~2,5 s) ; llama-3.3-70b-versatile, qwen/qwen3-32b et llama-3.1-8b-instant : 404
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", models: [
    { id: "openai/gpt-oss-120b", family: "gpt-oss", role: "voter" },
    { id: "qwen/qwen3.8-27b", family: "qwen3.8", role: "voter" },
  ] },
  // Gemini : ombre seulement depuis le 28/11/2026 (3.8-flash en HTTP 429). gemini-2.0-flash arrêté le 01/06/2026 ; gemini-2.5-flash et 2.5-pro dépréciés (redirigés
  // à partir du 01/12/2026). 3.5-flash-lite (−1,00 R) : ombre seulement (27/11/2026) ; 3.6-flash retiré (429, 28/11/2026).
  { name: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY", models: [
    { id: "gemini-3.8-flash", family: "gemini", shadowOnly: true },   // HTTP 429 immédiat (28/11/2026) : ombre
    { id: "gemini-3.5-flash-lite", family: "gemini", shadowOnly: true },
  ] },
  // Gemma 4 sur l'API Gemini, même clé : arbitre (4e famille) sans dépendre du pool gratuit d'OpenRouter.
  // Seuls ces deux modèles sont hébergés (doc Gemma, 24/11/2026). API native generateContent : l'endpoint compatible
  // OpenAI n'est pas documenté pour Gemma. Quota gratuit non précisé par la documentation.
  { name: "gemma", api: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/models", keyEnv: "GEMINI_API_KEY", models: [
    { id: "gemma-4-26b-a4b-it", family: "gemma", role: "arbiter" }, { id: "gemma-4-31b-it", family: "gemma", role: "arbiter" },
  ] },
  // Cerebras (offre gratuite, très rapide, quotas élevés) : 2 familles de plus
  { name: "cerebras", url: "https://api.cerebras.ai/v1/chat/completions", keyEnv: "CEREBRAS_API_KEY", models: [
    { id: "llama-3.3-70b", family: "llama-3.3-70b", role: "voter" }, { id: "qwen-3-32b", family: "qwen3-32b", role: "voter" },
  ] },
  // Mistral (palier gratuit « Experiment ») : architecture distincte des autres
  { name: "mistral", url: "https://api.mistral.ai/v1/chat/completions", keyEnv: "MISTRAL_API_KEY", models: [
    { id: "mistral-small-latest", family: "mistral-small", role: "voter" },
  ] },
  { name: "sambanova", url: "https://api.sambanova.ai/v1/chat/completions", keyEnv: "SAMBANOVA_API_KEY", models: [
    { id: "Meta-Llama-3.3-70B-Instruct", family: "llama-3.3-70b", role: "voter" }, { id: "DeepSeek-V3-0324", family: "deepseek-v3", role: "voter" },
  ] },
  // OpenRouter (compte gratuit, modèles :free). Cycle du 24/11/2026 : nemotron-3-ultra trop lent (60 s),
  // nemotron-3.5-lightning sans contenu (écartés). ernie : réponses vides, ombre seulement ; gemma : arbitre de secours.
  // Les votants :free changent sans prévenir (28/11/2026 : llama-3.3-70b-instruct:free → 404 « payant seulement »,
  // qwen3-235b-a22b:free → 404 « déprécié ») : ils ne sont plus écrits ici mais découverts dans le catalogue
  // (discoverOpenRouter, gardé 6 h) et ajoutés par withDiscovered. Reste fixe : le routeur automatique openrouter/free.
  // Délai : 60 s (openrouter/free choisit parfois un modèle lent ; 35 s multipliait les abandons).
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY", timeoutMs: 60_000, models: [
    { id: "baidu/ernie-5.5-flash-preview:free", family: "ernie", shadowOnly: true },
    { id: "google/gemma-4-31b-it:free", family: "gemma", role: "arbiter" },
    { id: "openrouter/free", family: "openrouter-auto", role: "voter" },
  ] },
];

/* ---------------- découverte des modèles gratuits d'OpenRouter ---------------- */
// Catalogue public (GET /api/v1/models, sans clé). Retenus : identifiant « :free » ou prix d'entrée et de sortie nuls,
// sortie texte seule, entrée texte, pas expiré ; écartés : le routeur openrouter/free (déjà fixe), les modèles des familles
// déjà présentes ailleurs (gpt-oss, qwen3.8, llama-3.3-70b, gemma = arbitre, gemini, ernie…), la liste noire (trop lents
// ou réponses vides) et les petits modèles (< 7 milliards de paramètres d'après l'identifiant). Tri : mode JSON supporté
// d'abord, puis les plus récents ; une seule version par famille (éditeur + nom de base) ; 3 au plus.
export const OPENROUTER_CFG = Object.freeze({
  url: "https://openrouter.ai/api/v1/models", max: 3, cacheH: 6, minParamsB: 7,
  deny: [/nemotron-3\.5-lightning/i, /nemotron-3-ultra/i],
});
// famille d'un modèle OpenRouter : éditeur + premier mot du nom (nvidia/nemotron-3.5-super-vl → nvidia/nemotron)
export const openrouterFamily = (id) => { const [vendor, name = ""] = String(id).toLowerCase().replace(/:free$/, "").split("/"); return `${vendor}/${name.split(/[-_.:]/)[0]}`; };
const isFree = (m) => /:free$/.test(m.id) || (String(m.pricing?.prompt) === "0" && String(m.pricing?.completion) === "0");
const paramsB = (id) => { const m = String(id).toLowerCase().match(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_:]|$)/); return m ? Number(m[1]) : null; };

// catalog : réponse de /api/v1/models ({ data: [...] }) ; providers : liste des fournisseurs (familles déjà présentes)
export function selectFreeModels(catalog, providers = DEFAULT_PROVIDERS, { now = Date.now(), cfg = OPENROUTER_CFG } = {}) {
  const fixed = new Set(providers.flatMap((p) => p.models.map((m) => m.id)));
  const known = [...new Set(providers.flatMap((p) => p.models.map((m) => String(m.family || "").toLowerCase())).filter((f) => f && f !== "openrouter-auto"))];
  const rows = (catalog?.data || []).filter((m) => m?.id && isFree(m) && !fixed.has(m.id) && m.id !== "openrouter/free"
    && (m.architecture?.output_modalities ?? ["text"]).every((x) => x === "text")
    && (m.architecture?.input_modalities ?? ["text"]).includes("text")
    && !(m.expiration_date && Date.parse(m.expiration_date) <= now)
    && !cfg.deny.some((re) => re.test(m.id))
    && !known.some((f) => m.id.toLowerCase().includes(f))
    && !(paramsB(m.id) != null && paramsB(m.id) < cfg.minParamsB));
  rows.sort((a, b) => Number((b.supported_parameters || []).includes("response_format")) - Number((a.supported_parameters || []).includes("response_format")) || (b.created ?? 0) - (a.created ?? 0));
  const out = [], fams = new Set();
  for (const m of rows) {
    const f = openrouterFamily(m.id);
    if (fams.has(f)) continue;
    fams.add(f); out.push({ id: m.id, family: `or:${f}`, role: "voter", name: m.name ?? m.id, created: m.created ?? null, json: (m.supported_parameters || []).includes("response_format") });
    if (out.length >= cfg.max) break;
  }
  return out;
}

// → { models, cache, source: "réseau" | "cache" | "cache périmé" | "aucun", error }. Jamais d'exception.
// cache : { at, models, catalogSize } (data/paper/openrouter_models.json) ; relu tant qu'il a moins de 6 h.
export async function discoverOpenRouter({ fetch: f = globalThis.fetch, cache = null, now = Date.now(), net = true, providers = DEFAULT_PROVIDERS, cfg = OPENROUTER_CFG } = {}) {
  const fresh = cache?.at && now - Date.parse(cache.at) < cfg.cacheH * 3600e3 && now >= Date.parse(cache.at);
  if (fresh) return { models: cache.models || [], cache, source: "cache" };
  if (!net) return { models: cache?.models || [], cache, source: cache?.models ? "cache périmé" : "aucun" };
  try {
    const r = await f(cfg.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cat = await r.json(), models = selectFreeModels(cat, providers, { now, cfg });
    const c = { at: new Date(now).toISOString(), models, catalogSize: cat?.data?.length ?? 0, free: (cat?.data || []).filter(isFree).length };
    return { models, cache: c, source: "réseau" };
  } catch (e) {
    return { models: cache?.models || [], cache, source: cache?.models ? "cache périmé" : "aucun", error: `catalogue OpenRouter : ${String(e.message || e).slice(0, 120)}` };
  }
}

// Ajoute les modèles découverts au fournisseur OpenRouter (sans doublon)
export function withDiscovered(providers = DEFAULT_PROVIDERS, models = []) {
  return providers.map((p) => (p.name !== "openrouter" ? p : { ...p, models: [...p.models, ...models.filter((m) => !p.models.some((x) => x.id === m.id)).map(({ id, family, role }) => ({ id, family, role }))] }));
}

export class LLMRouter {
  // env : variables d'environnement (clés) ; fetch injectable pour les tests
  // spacingMs : délai minimal entre deux requêtes vers un même hôte (anti-collision du palier gratuit d'OpenRouter)
  constructor({ env = process.env, providers = null, fetch: f = globalThis.fetch, timeoutMs = 60_000, spacingMs = { "openrouter.ai": 400 }, sleep = null } = {}) {
    const list = providers ?? (env.PAPER_LLM_PROVIDERS ? JSON.parse(env.PAPER_LLM_PROVIDERS) : DEFAULT_PROVIDERS);
    this.entries = list.flatMap((p) => (env[p.keyEnv] ? p.models.map((m) => ({ provider: p.name, url: p.url, api: p.api || "openai", key: env[p.keyEnv], model: m.id, family: m.family, role: m.role ?? null, shadowOnly: !!m.shadowOnly, timeoutMs: p.timeoutMs ?? null })) : []));
    this.fetch = f; this.timeoutMs = timeoutMs; this.failed = new Set(); this.log = [];
    this.spacingMs = spacingMs || {}; this.nextSlot = {}; this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  // modèles qui comptent dans les décisions (les modèles « ombre » sont à part : shadowModels)
  available() { return this.entries.filter((e) => !e.shadowOnly).map(({ provider, model, family, role }) => ({ provider, model, family, role })); }
  shadowModels() { return this.entries.filter((e) => e.shadowOnly).map(({ provider, model, family }) => ({ provider, model, family })); }
  // modèles classables (votants possibles, modèles ombre compris ; arbitres exclus), une ligne par identifiant
  rankable() {
    const seen = new Set();
    return this.entries.filter((e) => e.role !== "arbiter" && !seen.has(e.model) && seen.add(e.model)).map(({ provider, model, family, shadowOnly }) => ({ provider, model, family, shadowOnly }));
  }

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

  // Réserve le prochain créneau d'envoi vers l'hôte de e (appels parallèles décalés de spacingMs)
  async throttle(e) {
    const host = Object.keys(this.spacingMs).find((h) => String(e.url).includes(h));
    if (!host) return 0;
    const now = Date.now(), at = Math.max(now, this.nextSlot[host] ?? 0);
    this.nextSlot[host] = at + this.spacingMs[host];
    if (at > now) await this.sleep(at - now);
    return at - now;
  }

  async call(e, messages) {
    const send = async (json) => { const q = this.request(e, messages, json); await this.throttle(e);
      return this.fetch(q.url, { method: "POST", signal: AbortSignal.timeout(e.timeoutMs ?? this.timeoutMs), headers: q.headers, body: JSON.stringify(q.body) }); };
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
  // prefer : identifiants de modèles dans l'ordre voulu (classement dynamique), les autres suivent dans l'ordre par défaut ;
  // exclude : modèles à ne pas interroger ici.
  async collect(n, messages, validate, { excludeFamilies = [], role = null, prefer = null, exclude = [] } = {}) {
    const used = new Set(excludeFamilies), results = [], errors = [], skip = new Set(exclude);
    const rank = (e) => { const i = prefer ? prefer.indexOf(e.model) : -1; return i < 0 ? Infinity : i; };
    const queue = this.entries.filter((e) => !e.shadowOnly && !skip.has(e.model) && (!role || !e.role || e.role === role) && !this.failed.has(e.provider + "/" + e.model))
      .map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
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

  // Vote : tous les modèles décisionnels (non shadowOnly, rôle votant) en parallèle, sans contrainte de famille ni de nombre.
  // prefer : ordre d'affichage / d'enregistrement (classement). → { results: [{ provider, model, family, value }], errors }
  async collectAll(messages, validate, { role = "voter", prefer = null } = {}) {
    const rank = (e) => { const i = prefer ? prefer.indexOf(e.model) : -1; return i < 0 ? Infinity : i; };
    const seen = new Set(), list = this.entries.filter((e) => !e.shadowOnly && (!role || !e.role || e.role === role) && !this.failed.has(e.provider + "/" + e.model) && !seen.has(e.model) && seen.add(e.model))
      .map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
    const out = await Promise.all(list.map(async (e) => {
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
    return { results: out.filter((o) => o.value !== undefined).map((o) => ({ provider: o.e.provider, model: o.e.model, family: o.e.family, value: o.value })),
      errors: out.filter((o) => o.error).map((o) => `${o.e.provider}/${o.e.model} : ${o.error}`) };
  }

  // Modèles « ombre » (poids nul) : tous interrogés en parallèle, sans contrainte de famille. Leurs réponses servent
  // uniquement au PnL contrefactuel par modèle. extra : modèles décisionnels à interroger aussi en ombre (poids nul).
  async collectShadow(messages, validate, { extra = [] } = {}) {
    const list = this.entries.filter((e) => (e.shadowOnly || extra.includes(e.model)) && !this.failed.has(e.provider + "/" + e.model)), results = [], errors = [];
    await Promise.all(list.map(async (e) => {
      const t0 = Date.now();
      try {
        const v = validate(await this.call(e, messages));
        this.log.push({ provider: e.provider, model: e.model, ms: Date.now() - t0, ok: v.ok, error: v.ok ? null : v.error, shadowOnly: true });
        if (v.ok) results.push({ provider: e.provider, model: e.model, family: e.family, value: v.value, shadowOnly: true, ...(e.shadowOnly ? {} : { probe: true }) });
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

/* ---------------- Meta-Ensemble : panel LLM + champions de la Division 3 (league_engine.mjs) ---------------- */
// Le panel LLM garde 65 % du poids ; les champions actifs de D3 se partagent 35 %, au prorata de leur PSR multiplié par un
// bonus d'orthogonalité (jusqu'à +50 % quand leur signal penche contre le biais directionnel net du portefeuille).
// Sans champion en D3, les LLM gardent 100 % : rien n'est bloqué. Le mélange porte sur la conviction des ouvertures
// Hyperliquid à un seul actif : conviction = w_LLM × conviction des LLM + w_D3 × (50 + 50 × accord des champions).
// Les champions qui ne couvrent pas l'actif ne comptent pas (leur part revient aux LLM). Sous la conviction minimale (60),
// l'ouverture est écartée. Le moteur de risque s'applique ensuite comme toujours (délai de 8 h, stop 2 × ATR, panier
// corrélé, freins de drawdown).
export const META = Object.freeze({ llmWeight: 0.65, d3Weight: 0.35, orthBonus: 0.5, minConviction: 60 });

// Biais directionnel net des positions Hyperliquid (−1 tout short, +1 tout long), pondéré par le notionnel d'entrée.
export function portfolioBias(portfolio) {
  let net = 0, gross = 0;
  for (const q of portfolio?.positions || []) if (q.venue === "hl") { const n = Math.abs(q.entryUsd ?? q.size * q.entryPx ?? 0); net += (q.side === "long" ? 1 : -1) * n; gross += n; }
  return gross > 0 ? net / gross : 0;
}

// champions : [{ id, psr, signals: { TICKER: score }, regimeMult?, family? }] → { llm, d3, champions: [{ id, weight, psr, orth, lean, regimeMult }] }
// regimeMult (regime_agent.familyWeight) : 0 coupe le champion (poids 0), 0,5 l'atténue, 1,25 le favorise face aux autres.
// Tous coupés : les LLM reprennent 100 %.
export function metaWeights(champions = [], portfolio = null, cfg = META) {
  if (!champions.length) return { llm: 1, d3: 0, bias: r4(portfolioBias(portfolio)), champions: [] };
  const B = portfolioBias(portfolio);
  const rows = champions.map((c) => {
    const vals = Object.values(c.signals || {}), lean = vals.length ? vals.reduce((a, b) => a + Math.sign(b), 0) / vals.length : 0;
    const orth = 1 + cfg.orthBonus * Math.max(0, -lean * B), mult = c.regimeMult ?? 1;
    return { id: c.id, name: c.name, family: c.family ?? null, psr: c.psr ?? 0, lean: r4(lean), orth: r4(orth), regimeMult: mult, raw: Math.max(c.psr ?? 0, 0.01) * orth * mult };
  });
  const tot = rows.reduce((a, r) => a + r.raw, 0);
  if (!(tot > 0)) return { llm: 1, d3: 0, bias: r4(B), champions: rows.map(({ raw, ...r }) => ({ ...r, weight: 0 })) };
  return { llm: cfg.llmWeight, d3: cfg.d3Weight, bias: r4(B), champions: rows.map(({ raw, ...r }) => ({ ...r, weight: r4((cfg.d3Weight * raw) / tot) })) };
}

// Mélange la conviction des décisions OPEN. tickerOf(coin) → ticker suivi par les ligues (ou undefined).
// → { decisions (gardées), vetoed: [{ id, reason }], mixed: [{ id, llm, d3, wLLM, wD3, conviction, champions }] }
export function mixDecisions(decisions, dossier, champions, weights, { tickerOf = (c) => c, cfg = META } = {}) {
  const out = [], vetoed = [], mixed = [];
  const W = Object.fromEntries((weights?.champions || []).map((c) => [c.id, c.weight]));
  for (const d of decisions) {
    const c = d.action === "OPEN" ? dossier.candidates.find((x) => x.id === d.id) : null;
    const T = c && c.venue === "hl" && c.type !== "pair" ? tickerOf(c.coin) : undefined;
    const cover = T ? champions.filter((h) => h.signals?.[T] != null && W[h.id] > 0) : [];
    if (!cover.length || d.conviction == null) { out.push(d); continue; }
    const dir = c.side === "long" ? 1 : -1, wD3 = cover.reduce((a, h) => a + W[h.id], 0);
    const agree = cover.reduce((a, h) => a + W[h.id] * Math.max(-1, Math.min(1, h.signals[T] * dir)), 0) / wD3;
    const cD3 = 50 + 50 * agree, conviction = Math.round((1 - wD3) * d.conviction + wD3 * cD3);
    const rec = { id: d.id, llm: d.conviction, d3: r4(cD3), wLLM: r4(1 - wD3), wD3: r4(wD3), conviction, champions: cover.map((h) => ({ id: h.id, signal: h.signals[T], weight: W[h.id] })) };
    mixed.push(rec);
    if (conviction < cfg.minConviction) { vetoed.push({ id: d.id, reason: `meta-ensemble : conviction ${conviction} < ${cfg.minConviction} (LLM ${d.conviction}, champions D3 ${Math.round(cD3)})` }); continue; }
    out.push({ ...d, conviction, via: `${d.via} + D3` });
  }
  return { decisions: out, vetoed, mixed };
}
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
