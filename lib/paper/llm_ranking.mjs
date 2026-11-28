// Classement dynamique des modèles LLM et pondération capée des votes, à partir du PnL contrefactuel (shadow_book.json).
//
// 1. Score par modèle, sur ses trades fantômes clos des 30 derniers jours (40 au plus, les plus récents) :
//      composite c = 0,5 × (2·PSR − 1) + 0,3 × borne(ln PF, ±1) + 0,2 × (2·réussite − 1)   ∈ [−1, 1]
//      brut = 1 + c ∈ [0, 2] (1 = neutre) ; prior bayésien neutre : score = (5 × 1 + n × brut) / (5 + n),
//      et score = 1 exactement tant que n < 5 (les nouveaux modèles ont leur chance).
//    Pénalité légère de fiabilité : × (1 − 0,3 × f), f = moyenne mobile exponentielle des échecs récents (HTTP, délai,
//    JSON invalide), 0 à 1 ; un échec isolé coûte ~9 %, une série d'échecs au plus 30 %.
// 2. Sélection : les modèles sont triés par score ; les 6 premiers de familles distinctes (MIN_ACTIVE_VOTERS) votent
//    activement, ou tous si moins de 6 familles sont disponibles. Les suivants sont en sourdine (poids 0) ; un modèle
//    « fortement négatif » (brut ≤ 0,5) finit en queue de classement, donc en sourdine dès qu'il y a 6 meilleurs que lui
//    (le minimum de 6 votants prime). Les modèles `shadowOnly` du routeur restent en ombre (choix de configuration).
// 3. Poids : proportionnels au score parmi les votants qui ont réellement répondu, plafonnés à 30 % (MAX_WEIGHT) ;
//    l'excédent est redistribué au prorata des autres, somme = 1 (avant le mélange 65 % LLM / 35 % D3). Avec moins de
//    4 votants, 30 % est impossible à tenir : le plafond devient 1/n (poids égaux au plus).
// 4. Repêchage : à chaque réveil, 2 modèles en sourdine (rotation) votent en ombre ; leurs votes OPEN alimentent le
//    shadow book, donc leur score. Dès qu'un modèle en sourdine remonte dans le Top 6, il redevient actif.
import { psr } from "./metrics.mjs";

export const MIN_ACTIVE_VOTERS = 6;
export const MAX_WEIGHT = 0.30;
export const RANKING = Object.freeze({
  windowDays: 30, maxTrades: 40, minTrades: 5, priorN: 5,
  minActive: MIN_ACTIVE_VOTERS, maxWeight: MAX_WEIGHT, probes: 2,
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

// Poids proportionnels aux scores, plafonnés (remplissage par niveaux : l'excédent va aux autres au prorata), somme 1.
// scores : { id: score > 0 }. Plafond effectif : max(cap, 1/n).
export function capWeights(scores, cap = MAX_WEIGHT) {
  const ids = Object.keys(scores), n = ids.length;
  if (!n) return {};
  const c = Math.max(cap, 1 / n), w = {}, fixed = new Set();
  const s = Object.fromEntries(ids.map((id) => [id, Math.max(1e-9, Number(scores[id]) || 0)]));
  for (let k = 0; k <= n; k++) {
    const free = ids.filter((id) => !fixed.has(id)), mass = 1 - fixed.size * c, tot = free.reduce((a, id) => a + s[id], 0);
    for (const id of free) w[id] = (mass * s[id]) / tot;
    const over = free.filter((id) => w[id] > c + 1e-12);
    if (!over.length) break;
    for (const id of over) { fixed.add(id); w[id] = c; }
  }
  return Object.fromEntries(ids.map((id) => [id, r4(w[id])]));
}

// models : [{ model, family, provider, shadowOnly }] (votants possibles du routeur, arbitres exclus)
// → état du classement : models (triés, avec rang, statut, score, poids prévu), active, probes, rotation
export function rankModels({ models = [], book = null, state = null, now = Date.now(), cfg = RANKING } = {}) {
  const st = { ...emptyRanking(), ...(state || {}) }, health = st.health || {};
  const rows = models.map((m) => {
    const tr = windowTrades(book, m.model, now, cfg), p = performance(tr.map((s) => s.R)), fails = health[m.model]?.fails ?? 0, sc = scoreOf(p, fails, cfg);
    return { model: m.model, family: m.family, provider: m.provider, shadowOnly: !!m.shadowOnly, trades: p.n, winRate: r4(p.winRate), sumR: r4(p.sumR), avgR: r4(p.avgR),
      profitFactor: p.profitFactor === Infinity ? null : r4(p.profitFactor), sharpe: r4(p.sharpe), psr: r4(p.psr), raw: sc.raw, score: sc.score, fails: r4(fails),
      negative: sc.raw != null && sc.raw <= cfg.negativeRaw };
  }).sort((a, b) => b.score - a.score || b.trades - a.trades || a.model.localeCompare(b.model));
  // Top 6 de familles distinctes parmi les modèles décisionnels ; les autres sont en sourdine
  const active = [], fams = new Set();
  for (const r of rows) {
    if (r.shadowOnly || active.length >= cfg.minActive || fams.has(r.family)) continue;
    active.push(r.model); fams.add(r.family);
  }
  const planned = capWeights(Object.fromEntries(active.map((id) => [id, rows.find((r) => r.model === id).score])), cfg.maxWeight);
  const muted = rows.filter((r) => !r.shadowOnly && !active.includes(r.model)).map((r) => r.model).sort();
  const probes = [];
  for (let k = 0; k < Math.min(cfg.probes, muted.length); k++) probes.push(muted[(st.rotation + k) % muted.length]);
  const statusOf = (r) => (active.includes(r.model) ? "Actif" : r.shadowOnly ? "Ombre (config)" : probes.includes(r.model) ? "Ombre 0 % · repêchage" : "Ombre 0 %");
  return {
    version: 1, at: new Date(now).toISOString(), rotation: (st.rotation + probes.length) % Math.max(1, muted.length || 1), health,
    params: { windowDays: cfg.windowDays, maxTrades: cfg.maxTrades, minTrades: cfg.minTrades, minActive: cfg.minActive, maxWeight: cfg.maxWeight, cap: r4(Math.max(cfg.maxWeight, active.length ? 1 / active.length : 1)) },
    models: rows.map((r, i) => ({ rank: i + 1, ...r, status: statusOf(r), weight: planned[r.model] ?? 0 })),
    active, probes,
    // ordre de préférence pour le routeur : actifs d'abord, puis la réserve par rang (remplaçants si un actif échoue)
    order: rows.filter((r) => !r.shadowOnly).map((r) => r.model).sort((a, b) => (active.includes(b) - active.includes(a))),
    scores: Object.fromEntries(rows.map((r) => [r.model, r.score])),
  };
}

// Poids réels du cycle : parmi les votants qui ont répondu (un remplaçant prend la place d'un actif en échec).
export function voterWeights(models, ranking = null, cfg = RANKING) {
  return capWeights(Object.fromEntries(models.map((m) => [m, ranking?.scores?.[m] ?? 1])), cfg.maxWeight);
}

// Après le vote : poids effectivement appliqués et votants réels, pour l'affichage
export function recordCycle(ranking, weights, probesAnswered = []) {
  if (!ranking) return ranking;
  return { ...ranking, applied: weights, probesAnswered,
    models: ranking.models.map((m) => (m.model in weights ? { ...m, weight: weights[m.model], status: ranking.active.includes(m.model) ? "Actif" : "Actif (remplaçant)" }
      : ranking.active.includes(m.model) ? { ...m, weight: 0, status: "Actif · sans réponse" } : m)) };
}
