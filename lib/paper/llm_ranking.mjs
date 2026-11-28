// Classement dynamique des modèles LLM et pondération continue des votes, à partir du PnL contrefactuel (shadow_book.json).
//
// 1. Score par modèle, sur ses trades fantômes clos des 30 derniers jours (40 au plus, les plus récents) :
//      composite c = 0,5 × (2·PSR − 1) + 0,3 × borne(ln PF, ±1) + 0,2 × (2·réussite − 1)   ∈ [−1, 1]
//      brut = 1 + c ∈ [0, 2] (1 = neutre) ; prior bayésien neutre : score = (5 × 1 + n × brut) / (5 + n),
//      et score = 1 exactement tant que n < 5 (les nouveaux modèles ont leur chance).
//    Pénalité légère de fiabilité : × (1 − 0,3 × f), f = moyenne mobile exponentielle des échecs récents (HTTP, délai,
//    JSON invalide), 0 à 1 ; un échec isolé coûte ~9 %, une série d'échecs au plus 30 %.
// 2. Participation : TOUS les modèles décisionnels (non `shadowOnly`) votent à chaque réveil, sans limite de nombre.
//    Les modèles `shadowOnly` (choix de configuration : Gemini, Ernie…) ont un poids nul dans la décision, mais leurs
//    votes alimentent toujours le shadow book.
// 3. Poids cible (continu, strictement positif) : brut = max(0,2 ; score)², normalisé, borné entre 4 % (MIN_WEIGHT : un
//    modèle mal classé garde une voix faible mais réelle) et 30 % (MAX_WEIGHT) ; somme 1. Le meilleur pèse jusqu'à 7,5 ×
//    le plus faible. Bornes infaisables (moins de 4 modèles, ou plus de 25) : plafond 1/n au moins, plancher 1/n au plus.
// 4. Une voix par modèle sous-jacent : les copies d'un même modèle servies par plusieurs fournisseurs (même famille, ex.
//    llama 3.3 70b sur Cerebras, OpenRouter et SambaNova) votent toutes, mais partagent UN poids. Les bornes 4 % / 30 %
//    s'appliquent à la famille (brut de la famille = moyenne des bruts de ses copies), puis le poids est réparti entre les
//    copies au prorata de leur brut : une copie seule peut donc descendre sous 4 %.
// 5. Poids du cycle : un modèle actif qui ne répond pas (délai, 429, JSON illisible) pèse 0 sur ce cycle ; sa part est
//    redistribuée aux modèles qui ont répondu (même calcul, sur les seuls répondants). Si une copie d'une famille se tait,
//    l'autre porte seule la voix de la famille.
import { psr } from "./metrics.mjs";

export const MAX_WEIGHT = 0.30;
export const MIN_WEIGHT = 0.04;
export const RANKING = Object.freeze({
  windowDays: 30, maxTrades: 40, minTrades: 5, priorN: 5,
  maxWeight: MAX_WEIGHT, minWeight: MIN_WEIGHT, rawFloor: 0.2, rawPower: 2,
  mix: { psr: 0.5, pf: 0.3, wr: 0.2 }, negativeRaw: 0.5,
  failDecay: 0.7, failPenalty: 0.3, minScore: 0.05,
});

const D = 24 * 3600e3;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export const emptyRanking = () => ({ version: 1, at: null, rotation: 0, health: {}, models: [], active: [], probes: [] });

// Trades fantômes clos d'un modèle dans la fenêtre glissante
export function windowTrades(book, model, now = Date.now(), cfg = RANKING) {
  return (book?.closed || []).filter((s) => s.model === model && Number.isFinite(s.R) && now - Date.parse(s.closedAt) <= cfg.windowDays * D && Date.parse(s.closedAt) <= now)
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)).slice(0, cfg.maxTrades);
}

export function performance(Rs) {
  const n = Rs.length;
  if (!n) return { n: 0, wins: 0, winRate: null, sumR: 0, avgR: null, profitFactor: null, sharpe: null, psr: null };
  const wins = Rs.filter((r) => r > 0), gain = wins.reduce((s, r) => s + r, 0), loss = -Rs.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  const m = mean(Rs), sd = n > 1 ? Math.sqrt(Rs.reduce((s, r) => s + (r - m) ** 2, 0) / (n - 1)) : 0;
  return { n, wins: wins.length, winRate: wins.length / n, sumR: Rs.reduce((s, r) => s + r, 0), avgR: m,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : null, sharpe: sd > 0 ? m / sd : null, psr: psr(Rs) };
}

// Composite c ∈ [−1, 1] ; null sans assez de trades
export function composite(p, cfg = RANKING) {
  if (p.n < cfg.minTrades) return null;
  const ps = p.psr ?? (p.avgR > 0 ? 1 : p.avgR < 0 ? 0 : 0.5);            // écart-type nul : le signe de la moyenne décide
  const pf = p.profitFactor == null ? 0 : p.profitFactor === Infinity ? 1 : p.profitFactor <= 0 ? -1 : clip(Math.log(p.profitFactor), -1, 1);
  return cfg.mix.psr * (2 * ps - 1) + cfg.mix.pf * pf + cfg.mix.wr * (2 * p.winRate - 1);
}

export function scoreOf(p, fails = 0, cfg = RANKING) {
  const c = composite(p, cfg), raw = c == null ? null : 1 + c;
  const base = raw == null ? 1 : (cfg.priorN * 1 + p.n * raw) / (cfg.priorN + p.n);
  return { raw: r4(raw), score: r4(Math.max(cfg.minScore, base * (1 - cfg.failPenalty * clip(fails, 0, 1)))) };
}

// Santé des modèles : moyenne mobile exponentielle des échecs, d'après le journal du routeur de ce cycle.
// log : [{ model, ok, error }] (LLMRouter.log). Un modèle non appelé garde sa valeur.
export function updateHealth(health = {}, log = [], now = Date.now(), cfg = RANKING) {
  const out = structuredClone(health || {}), byModel = {};
  for (const e of log) (byModel[e.model] ??= []).push(e);
  for (const [model, es] of Object.entries(byModel)) {
    const failed = es.some((e) => !e.ok), prev = out[model] ?? { fails: 0, calls: 0, failures: 0 };
    out[model] = { fails: r4(cfg.failDecay * prev.fails + (1 - cfg.failDecay) * (failed ? 1 : 0)), calls: prev.calls + 1, failures: prev.failures + (failed ? 1 : 0),
      lastAt: new Date(now).toISOString(), lastError: failed ? String(es.find((e) => !e.ok).error || "échec").slice(0, 200) : prev.lastError ?? null };
  }
  return out;
}

// Poids proportionnels à `raw`, bornés dans [floor, cap], somme 1 (remplissage par niveaux : un poids borné est figé,
// le reste se répartit au prorata entre les autres). Bornes effectives : cap ≥ 1/n, floor ≤ 1/n (toujours faisables).
export function boundedWeights(raw, { cap = MAX_WEIGHT, floor = MIN_WEIGHT } = {}) {
  const ids = Object.keys(raw), n = ids.length;
  if (!n) return {};
  const hi = Math.max(cap, 1 / n), lo = Math.min(floor, 1 / n), w = {}, fixed = new Map();
  const s = Object.fromEntries(ids.map((id) => [id, Math.max(1e-9, Number(raw[id]) || 0)]));
  for (let k = 0; k <= 2 * n; k++) {
    const free = ids.filter((id) => !fixed.has(id)), mass = 1 - [...fixed.values()].reduce((a, b) => a + b, 0), tot = free.reduce((a, id) => a + s[id], 0);
    for (const id of free) w[id] = tot > 0 ? (mass * s[id]) / tot : mass / free.length;
    const over = free.filter((id) => w[id] > hi + 1e-12), under = free.filter((id) => w[id] < lo - 1e-12);
    if (!over.length && !under.length) break;
    for (const id of over.length ? over : under) { const v = over.length ? hi : lo; fixed.set(id, v); w[id] = v; }
  }
  for (const [id, v] of fixed) w[id] = v;
  return Object.fromEntries(ids.map((id) => [id, r4(w[id])]));
}
// Plafond seul (compatibilité) : poids proportionnels aux scores, plafonnés, sans plancher
export const capWeights = (scores, cap = MAX_WEIGHT) => boundedWeights(scores, { cap, floor: 0 });

const rawOf = (sc, cfg = RANKING) => Math.max(cfg.rawFloor, sc ?? 1) ** cfg.rawPower;

// Poids par famille (bornés dans [4 %, 30 %]), puis répartis entre les copies de la famille au prorata de leur brut.
// raw : { modèle: brut } ; families : { modèle: famille } (un modèle sans famille connue forme sa propre famille).
export function familyWeights(raw, families = {}, cfg = RANKING) {
  const groups = {};
  for (const m of Object.keys(raw)) (groups[families[m] ?? m] ??= []).push(m);
  const famRaw = Object.fromEntries(Object.entries(groups).map(([f, ms]) => [f, ms.reduce((a, m) => a + raw[m], 0) / ms.length]));
  const fw = boundedWeights(famRaw, { cap: cfg.maxWeight, floor: cfg.minWeight }), out = {};
  for (const [f, ms] of Object.entries(groups)) {
    const tot = ms.reduce((a, m) => a + raw[m], 0);
    for (const m of ms) out[m] = r4(tot > 0 ? (fw[f] * raw[m]) / tot : fw[f] / ms.length);
  }
  return out;
}

// Poids cibles des modèles actifs à partir de leurs scores : max(0,2 ; score)², une voix bornée [4 %, 30 %] par famille
export function targetWeights(scores, cfg = RANKING, families = {}) {
  return familyWeights(Object.fromEntries(Object.entries(scores).map(([m, sc]) => [m, rawOf(sc, cfg)])), families, cfg);
}

// Code court d'une erreur de modèle, pour l'affichage (« sans réponse · 429 TPM »)
export function errorCode(msg) {
  const m = String(msg || "");
  if (/\b429\b|rate.?limit|too many requests/i.test(m)) return /tokens? per minute|\bTPM\b|rate_limit_exceeded.*tokens|Limit \d+, Used/i.test(m) ? "429 TPM" : /per day|\bRPD\b|daily/i.test(m) ? "429 quota jour" : "429";
  if (/\b404\b/.test(m)) return /policy|guardrail|data policy|privacy/i.test(m) ? "404 policy" : "404 modèle";
  if (/\b40[13]\b/.test(m)) return "401 clé";
  if (/\b5\d\d\b/.test(m)) return "5xx serveur";
  if (/timeout|timed out|aborted|abort/i.test(m)) return "délai";
  if (/réponse invalide|non JSON|aucun JSON|JSON incomplet|Unexpected token|JSON/i.test(m)) return "JSON";
  if (/sans contenu|vide/i.test(m)) return "réponse vide";
  return m ? "erreur" : null;
}

// models : [{ model, family, provider, shadowOnly }] (votants possibles du routeur, arbitres exclus)
// → état du classement : models (triés, avec rang, statut, score, poids cible), active (tous les non-shadowOnly), order, scores
export function rankModels({ models = [], book = null, state = null, now = Date.now(), cfg = RANKING } = {}) {
  const st = { ...emptyRanking(), ...(state || {}) }, health = st.health || {};
  const rows = models.map((m) => {
    const tr = windowTrades(book, m.model, now, cfg), p = performance(tr.map((s) => s.R)), fails = health[m.model]?.fails ?? 0, sc = scoreOf(p, fails, cfg);
    return { model: m.model, family: m.family, provider: m.provider, shadowOnly: !!m.shadowOnly, trades: p.n, winRate: r4(p.winRate), sumR: r4(p.sumR), avgR: r4(p.avgR),
      profitFactor: p.profitFactor === Infinity ? null : r4(p.profitFactor), sharpe: r4(p.sharpe), psr: r4(p.psr), raw: sc.raw, score: sc.score, fails: r4(fails),
      negative: sc.raw != null && sc.raw <= cfg.negativeRaw };
  }).sort((a, b) => b.score - a.score || b.trades - a.trades || a.model.localeCompare(b.model));
  const active = rows.filter((r) => !r.shadowOnly).map((r) => r.model);
  const families = Object.fromEntries(rows.filter((r) => !r.shadowOnly).map((r) => [r.model, r.family ?? r.model]));
  const target = targetWeights(Object.fromEntries(active.map((id) => [id, rows.find((r) => r.model === id).score])), cfg, families);
  // copies d'un même modèle (même famille) : voix partagée
  const shared = Object.fromEntries(active.map((m) => [m, active.filter((x) => x !== m && families[x] === families[m])]));
  return {
    version: 2, at: new Date(now).toISOString(), health,
    params: { windowDays: cfg.windowDays, maxTrades: cfg.maxTrades, minTrades: cfg.minTrades, maxWeight: cfg.maxWeight, minWeight: cfg.minWeight, active: active.length,
      cap: r4(Math.max(cfg.maxWeight, active.length ? 1 / active.length : 1)), floor: r4(Math.min(cfg.minWeight, active.length ? 1 / active.length : 0)) },
    models: rows.map((r, i) => ({ rank: i + 1, ...r, status: r.shadowOnly ? "Ombre (config)" : "Actif", target: target[r.model] ?? 0, weight: target[r.model] ?? 0, sharedWith: shared[r.model] ?? [],
      lastError: health[r.model]?.lastError ? { code: errorCode(health[r.model].lastError), message: health[r.model].lastError, at: health[r.model].lastAt } : null })),
    active, probes: [], target, families,
    order: active,                                        // ordre de préférence (rang) pour les appels uniques (régime, arbitre)
    scores: Object.fromEntries(rows.map((r) => [r.model, r.score])),
  };
}

// Poids réels du cycle : modèles actifs qui ont répondu, même calcul que les poids cibles (une voix bornée par famille)
// sur les seuls répondants. Sans classement : poids égaux.
export function voterWeights(models, ranking = null, cfg = RANKING) {
  if (!models.length) return {};
  return familyWeights(Object.fromEntries(models.map((m) => [m, rawOf(ranking?.scores?.[m], cfg)])), ranking?.families ?? {}, cfg);
}

// Après le vote : poids du cycle et cause d'échec des actifs muets (journal du routeur), pour l'affichage.
// weights : { modèle: poids du cycle } (votants qui ont répondu) ; log : LLMRouter.log du cycle.
export function recordCycle(ranking, weights, log = []) {
  if (!ranking) return ranking;
  const lastErr = {};
  for (const e of Array.isArray(log) ? log : []) if (!e.ok) lastErr[e.model] = e.error; else if (e.model in lastErr && e.ok) delete lastErr[e.model];
  return { ...ranking, applied: weights, cycleAt: new Date().toISOString(),
    models: ranking.models.map((m) => {
      if (m.shadowOnly) return { ...m, cycle: 0, weight: 0 };
      if (m.model in weights) return { ...m, cycle: weights[m.model], weight: weights[m.model], status: "Actif", cycleError: null };
      const msg = lastErr[m.model] ?? null, code = errorCode(msg) ?? "non appelé";
      return { ...m, cycle: 0, weight: 0, status: `Actif · sans réponse · ${code}`, cycleError: msg ? { code, message: String(msg).slice(0, 300) } : { code, message: null } };
    }) };
}
