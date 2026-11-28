// Routeur LLM multi-fournisseurs (SPEC §4.1). Tous parlent le format « chat completions » d'OpenAI.
// Socle (nettoyé le 28/11/2026) : DeepSeek (deepseek-v4-pro, deepseek-flash), Groq (gpt-oss-120b, qwen3.8-27b) et
// OpenRouter (routeur openrouter/free + 1 modèle :free d'au moins 24 Md de paramètres découvert dans le catalogue).
// Retirés : Mistral (HTTP 402, abonnement), Gemini / Gemma via Google AI Studio (HTTP 429, JSON incomplets), Ernie
// (réponses vides), Cerebras et SambaNova (sans clé), GitHub Models (service retiré le 30/07/2026). Un fournisseur
// sans clé est ignoré.
// Routage par tâche :
//   vote (decide) : collectAll, TOUS les modèles du socle en parallèle, poids du classement dynamique (llm_ranking.mjs,
//     4 % à 30 % par modèle : deepseek-v4-pro ne peut jamais emporter seul le consensus) ;
//   arbitrage et synthèse du régime macro : deepseek-v4-pro d'abord (ARBITER_PREFER), sinon le n° 1 du classement ;
//   compilation des Blueprints et mutation Gen-2 : deepseek-flash d'abord (TASK_PREFER), le quota de Groq reste au vote.
// OpenRouter (palier gratuit) : 400 ms au moins entre deux requêtes vers openrouter.ai, même lancées en parallèle.
// Familles : deux copies d'un même modèle partagent une voix (llm_ranking.mjs). `shadowOnly: true` (aucun aujourd'hui)
// = poids nul, votes suivis à part dans le shadow book.
// Les identifiants de modèles changent souvent : la liste se remplace sans toucher au code avec la variable
// d'environnement PAPER_LLM_PROVIDERS (même format JSON que DEFAULT_PROVIDERS).
import { extractJson } from "./schema.mjs";

export const DEFAULT_PROVIDERS = [
  // DeepSeek, payant à l'usage (pas de palier gratuit). Identifiants vérifiés dans la documentation le 28/11/2026 :
  // deepseek-v4-pro (DeepSeek-V4-Pro-0813) et deepseek-flash (DeepSeek-V4.1-Flash-1017). Mode JSON pris en charge.
  // Les deux raisonnent par défaut avant de répondre : délai de 200 s et 8 000 tokens de sortie (le raisonnement est
  // décompté de max_tokens avant la réponse : un budget plus bas tronque content, qui revient vide).
  // fallback : alias historique essayé si l'identifiant est refusé (HTTP 404, ou 400 « model not exist »).
  { name: "deepseek", url: "https://api.deepseek.com/chat/completions", keyEnv: "DEEPSEEK_API_KEY", timeoutMs: 200_000, maxTokens: 8000, models: [
    { id: "deepseek-v4-pro", family: "deepseek-v4-pro", fallback: "deepseek-reasoner" },
    { id: "deepseek-flash", family: "deepseek-flash", fallback: "deepseek-chat" },
  ] },
  // Groq, vérifié en réel le 24/11/2026 (~2,5 s) ; quota gratuit de 8 000 tokens/min par modèle (réservé au vote)
  // Groq compte dans le quota par minute (8 000 tokens) l'entrée ET le max_tokens demandé : dossier ≤ 2 500 tokens
  // (decision.PROMPT_BUDGET) et réponse plafonnée à 1 400 tokens, soit ~3 900 par appel. gpt-oss : raisonnement court
  // (reasoning_effort « low ») pour que le bulletin tienne dans ces 1 400 tokens.
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", maxTokens: 1400, models: [
    // json: false : pas de response_format (Groq rend HTTP 400 json_validate_failed quand le raisonnement précède « { ») ;
    // le bloc {...} est extrait de la réponse texte
    { id: "openai/gpt-oss-120b", family: "gpt-oss", json: false, extra: { reasoning_effort: "low" } },
    { id: "qwen/qwen3.8-27b", family: "qwen3.8" },
  ] },
  // OpenRouter (compte gratuit). Les modèles :free changent sans prévenir (28/11/2026 : llama-3.3-70b-instruct:free et
  // qwen3-235b-a22b:free en 404) : 1 modèle est découvert dans le catalogue (discoverOpenRouter, gardé 6 h), en plus du
  // routeur automatique openrouter/free. Délai : 60 s (openrouter/free choisit parfois un modèle lent).
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY", timeoutMs: 60_000, models: [
    { id: "openrouter/free", family: "openrouter-auto" },
  ] },
];
// Préférences par tâche (le reste suit dans l'ordre du classement, puis l'ordre par défaut)
export const ARBITER_PREFER = Object.freeze(["deepseek-v4-pro"]);
export const TASK_PREFER = Object.freeze(["deepseek-flash", "deepseek-v4-pro", "qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openrouter/free"]);

/* ---------------- découverte des modèles gratuits d'OpenRouter ---------------- */
// Catalogue public (GET /api/v1/models, sans clé). Retenus : identifiant « :free » ou prix d'entrée et de sortie nuls,
// sortie texte seule, entrée texte, pas expiré, et AU MOINS 24 milliards de paramètres d'après l'identifiant (taille
// inconnue : écarté, pour éviter les petits modèles faibles) ; écartés aussi : le routeur openrouter/free (déjà fixe),
// les familles déjà présentes (gpt-oss, qwen3.8, deepseek…) et la liste noire (trop lents ou réponses vides).
// Tri : mode JSON supporté d'abord, puis le plus gros, puis le plus récent ; 1 modèle au plus.
export const OPENROUTER_CFG = Object.freeze({
  url: "https://openrouter.ai/api/v1/models", max: 1, cacheH: 6, minParamsB: 24, requireSize: true,
  // nemotron-3.5-lightning (réponses vides), nemotron-3-ultra (60 s), Gemma 4 gratuit (pool amont saturé en permanence, 429)
  deny: [/nemotron-3\.5-lightning/i, /nemotron-3-ultra/i, /^google\/gemma-4-(31b|26b)/i, /ernie/i],   // + Ernie : réponses vides
  routing: 3,   // modèles :free passés à openrouter/free (champ « models »), taille connue ou non
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
    && (paramsB(m.id) != null ? paramsB(m.id) >= cfg.minParamsB : !cfg.requireSize));
  const json = (m) => Number((m.supported_parameters || []).includes("response_format"));
  rows.sort((a, b) => json(b) - json(a) || (paramsB(b.id) ?? 0) - (paramsB(a.id) ?? 0) || (b.created ?? 0) - (a.created ?? 0));
  const out = [], fams = new Set();
  for (const m of rows) {
    const f = openrouterFamily(m.id);
    if (fams.has(f)) continue;
    fams.add(f); out.push({ id: m.id, family: `or:${f}`, name: m.name ?? m.id, params: paramsB(m.id), created: m.created ?? null, json: !!json(m) });
    if (out.length >= cfg.max) break;
  }
  return out;
}

// → { models, cache, source: "réseau" | "cache" | "cache périmé" | "aucun", error }. Jamais d'exception.
// cache : { at, models, catalogSize } (data/paper/openrouter_models.json) ; relu tant qu'il a moins de 6 h.
export async function discoverOpenRouter({ fetch: f = globalThis.fetch, cache = null, now = Date.now(), net = true, providers = DEFAULT_PROVIDERS, cfg = OPENROUTER_CFG } = {}) {
  // un cache qui contient un modèle désormais refusé (ex. google/gemma-4-31b-it:free) est rafraîchi tout de suite
  const denied = [...(cache?.models || []).map((m) => m.id), ...(cache?.routing || [])].some((id) => cfg.deny.some((re) => re.test(id)));
  const fresh = !denied && cache?.at && now - Date.parse(cache.at) < cfg.cacheH * 3600e3 && now >= Date.parse(cache.at);
  if (denied) cache = { ...cache, models: (cache.models || []).filter((m) => !cfg.deny.some((re) => re.test(m.id))), routing: (cache.routing || []).filter((id) => !cfg.deny.some((re) => re.test(id))) };
  if (fresh) return { models: cache.models || [], routing: cache.routing || [], cache, source: "cache" };
  if (!net) return { models: cache?.models || [], routing: cache?.routing || [], cache, source: cache?.models ? "cache périmé" : "aucun" };
  try {
    const r = await f(cfg.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cat = await r.json(), models = selectFreeModels(cat, providers, { now, cfg });
    // liste de routage d'openrouter/free : les meilleurs modèles :free du catalogue (mode JSON d'abord), même de taille inconnue
    const routing = selectFreeModels(cat, providers, { now, cfg: { ...cfg, max: cfg.routing ?? 3, requireSize: false } }).map((m) => m.id);
    const c = { at: new Date(now).toISOString(), models, routing, catalogSize: cat?.data?.length ?? 0, free: (cat?.data || []).filter(isFree).length };
    return { models, routing, cache: c, source: "réseau" };
  } catch (e) {
    return { models: cache?.models || [], routing: cache?.routing || [], cache, source: cache?.models ? "cache périmé" : "aucun", error: `catalogue OpenRouter : ${String(e.message || e).slice(0, 120)}` };
  }
}

// Ajoute les modèles découverts au fournisseur OpenRouter (sans doublon). routing : 3 identifiants :free au plus ;
// openrouter/free les reçoit dans le champ « models » (routage direct, essayés dans l'ordre) au lieu de chercher seul
// un modèle libre, ce qui dépassait parfois 60 s.
export function withDiscovered(providers = DEFAULT_PROVIDERS, models = [], routing = []) {
  return providers.map((p) => (p.name !== "openrouter" ? p : { ...p, models: [
    ...p.models.map((m) => (m.id === "openrouter/free" && routing.length ? { ...m, extra: { ...(m.extra || {}), model: routing[0], models: routing.slice(0, 3) } } : m)),
    ...models.filter((m) => !p.models.some((x) => x.id === m.id)).map(({ id, family }) => ({ id, family }))] }));
}

export class LLMRouter {
  // env : variables d'environnement (clés) ; fetch injectable pour les tests
  // spacingMs : délai minimal entre deux requêtes vers un même hôte (anti-collision du palier gratuit d'OpenRouter)
  constructor({ env = process.env, providers = null, fetch: f = globalThis.fetch, timeoutMs = 60_000, spacingMs = { "openrouter.ai": 400 }, sleep = null } = {}) {
    const list = providers ?? (env.PAPER_LLM_PROVIDERS ? JSON.parse(env.PAPER_LLM_PROVIDERS) : DEFAULT_PROVIDERS);
    this.entries = list.flatMap((p) => (env[p.keyEnv] ? p.models.map((m) => ({ provider: p.name, url: p.url, api: p.api || "openai", key: env[p.keyEnv], model: m.id, family: m.family, role: m.role ?? null, shadowOnly: !!m.shadowOnly, timeoutMs: p.timeoutMs ?? null, maxTokens: m.maxTokens ?? p.maxTokens ?? null, extra: m.extra ?? null, json: m.json ?? p.json ?? true, fallback: m.fallback ?? null })) : []));
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

  // Requête « chat completions » (OpenAI). max_tokens : 4 000 par défaut (marge pour les modèles qui raisonnent avant de
  // répondre, comme gpt-oss), réglable par fournisseur (DeepSeek : 8 000).
  // extra : champs propres au modèle (reasoning_effort, routage « models » d'openrouter/free), retirés si le serveur les refuse
  // json : mode JSON demandé ; jamais pour un modèle marqué json: false. Avec response_format, l'API DeepSeek exige le mot
  // « json » dans les messages (sinon content revient vide) : une consigne est ajoutée au message système s'il manque.
  // model : identifiant envoyé (alias de repli), e.model par défaut.
  request(e, messages, json, extra = true, model = e.model) {
    const useJson = json && e.json !== false;
    let msgs = messages;
    if (useJson && !messages.some((m) => /json/i.test(String(m.content ?? "")))) {
      const i = messages.findIndex((m) => m.role === "system"), hint = "Answer with a single valid JSON object.";
      msgs = i >= 0 ? messages.map((m, k) => (k === i ? { ...m, content: `${m.content}\n${hint}` } : m)) : [{ role: "system", content: hint }, ...messages];
    }
    return { url: e.url, headers: { "content-type": "application/json", authorization: `Bearer ${e.key}` },
      body: { model, messages: msgs, temperature: 0.2, max_tokens: e.maxTokens ?? 4000, ...(useJson ? { response_format: { type: "json_object" } } : {}), ...(extra && e.extra ? e.extra : {}) } };
  }
  // texte de la réponse ; content vide → repli sur le raisonnement (reasoning_content de DeepSeek, reasoning de Groq) s'il
  // contient un objet JSON
  static textOf(e, body) {
    const m = body?.choices?.[0]?.message || {};
    if (typeof m.content === "string" && m.content.trim()) return m.content;
    const r = [m.reasoning_content, m.reasoning].find((x) => typeof x === "string" && /\{[\s\S]*\}/.test(x));
    return r ?? m.content;
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
    let model = e.model;
    const send = async (json, extra = true) => { const q = this.request(e, messages, json, extra, model); await this.throttle(e);
      const r = await this.fetch(q.url, { method: "POST", signal: AbortSignal.timeout(e.timeoutMs ?? this.timeoutMs), headers: q.headers, body: JSON.stringify(q.body) });
      return { r, raw: await r.text() }; };
    const unknownModel = ({ r, raw }) => r.status === 404 || (r.status === 400 && /model.{0,40}(not.?exist|not.?found|unknown|invalid|does not)|(invalid|unknown).{0,20}model/i.test(raw));
    let res = await send(true);
    // identifiant refusé (modèle renommé) : alias de repli (deepseek-chat, deepseek-reasoner)
    if (unknownModel(res) && e.fallback) { model = e.fallback; res = await send(true); }
    if (res.r.status === 400 && e.extra) res = await send(true, false);                 // option propre au modèle refusée : sans elle
    if (res.r.status === 400 && e.json !== false) res = await send(false, false);       // certains modèles gratuits refusent le mode JSON
    const { r, raw } = res, excerpt = raw.replace(/\s+/g, " ").trim().slice(0, 200), via = model !== e.model ? ` (repli ${model})` : "";
    // le début du corps dit pourquoi (modèle retiré ou renommé, quota, clé…), au lieu d'un simple code HTTP
    if (!r.ok) throw new Error(`HTTP ${r.status}${via} : ${excerpt || "(corps vide)"}`);
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error(`réponse non JSON (HTTP ${r.status}) : ${excerpt || "(corps vide)"}`); }
    const text = LLMRouter.textOf(e, body);
    if (!text) {
      const fin = body?.choices?.[0]?.finish_reason;
      throw new Error(fin === "length" ? `réponse tronquée (finish_reason length, max_tokens ${e.maxTokens ?? 4000} épuisé par le raisonnement)${via}` : `réponse sans contenu${fin ? ` (finish_reason ${fin})` : ""}${via} : ${excerpt}`);
    }
    if (via) e.resolvedModel = model;
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
