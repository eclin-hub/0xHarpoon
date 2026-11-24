// Notes des baleines par catégorie (SPEC §3.1), sans LLM.
//
// Chaque position résolue d'une baleine donne un score s ∈ [−1, 1] :
// - Hyperliquid (fermeture détectée entre deux relevés) : s = tanh(PnL latent à la fermeture / notionnel / 5 %).
// - Polymarket : avantage réalisé s = issue − prix moyen d'entrée (issue = 1 si l'option gagne, 0 sinon) quand le marché
//   est résolu ; sinon (revente avant la fin) s = dernier prix − prix moyen. C'est la version « Brier inversé » retenue :
//   on ne connaît pas la probabilité que la baleine avait en tête, seulement le prix payé, et un pari gagnant acheté
//   à 0,20 doit compter plus qu'un pari gagnant acheté à 0,95.
// Le poids suit une moyenne mobile exponentielle : W ← (1 − α)·W + α·(1 + s), borné à [0,5 ; 2].
//
// Phase de démarrage (warmupDays après la création du fichier) : une baleine sans historique est admise, avec un poids
// de départ tiré de son PnL connu (classements), borné à [0,75 ; 1,25] tant qu'elle a moins de 15 positions résolues.
// Après cette phase, il faut 15 positions résolues dans la catégorie. Toujours exclue : creux cumulé > maxCumDrawdown.
import { CONFIG } from "./config.mjs";
import { pmTopic } from "../topics.mjs";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const DAY = 86400e3;
export const keyOf = (venue, addr) => `${venue}:${String(addr).toLowerCase()}`;

/* ---------- catégories ---------- */

const HL_MACRO = new Set(["xyz:DXY", "xyz:EUR", "xyz:JPY"]);
// crypto pour tout le marché principal ; matières premières et indices pour le dex xyz ; devises → macro
export function categoryOfHl(coin) {
  if (!coin) return null;
  if (HL_MACRO.has(coin)) return "macro";
  if (coin.startsWith("xyz:") || coin === "PAXG") return "commodities";
  return "crypto";
}

const COMMO_TOPICS = new Set(["OIL", "GOLD", "SILVER", "NATGAS", "US_EQ", "TSLA", "NVDA"]);
// sports et divers : pas de catégorie (exclus de la poche cœur, SPEC §2)
export function categoryOfPm({ title = "", topic = null, category = null } = {}) {
  const t = topic ?? pmTopic(title);
  if (t && COMMO_TOPICS.has(t)) return "commodities";
  if (category === "crypto" || (t && !COMMO_TOPICS.has(t) && t !== "USD")) return "crypto";
  if (category === "finance" || t === "USD") return "macro";
  if (category === "politics") return "geopolitics";
  return null;
}

/* ---------- scores d'une position résolue ---------- */

export function scoreHlClose(ev, cfg = CONFIG) {
  if (!(ev?.notional > 0) || !Number.isFinite(ev.upnl)) return null;
  return Math.tanh(ev.upnl / ev.notional / cfg.whales.hlReturnScale);
}

// resolution : sortie de pm.normalizeResolution (ou null si inconnue)
export function scorePmClose(ev, resolution = null) {
  if (!(ev?.avg > 0 && ev.avg < 1)) return null;
  if (resolution?.resolved) {
    const won = resolution.winner.outcome != null && ev.outcome != null
      ? String(resolution.winner.outcome).toLowerCase() === String(ev.outcome).toLowerCase()
      : resolution.winner.token === String(ev.token);
    return clamp((won ? 1 : 0) - ev.avg, -1, 1);
  }
  return Number.isFinite(ev.price) && ev.price > 0 ? clamp(ev.price - ev.avg, -1, 1) : null;
}

/* ---------- état ---------- */

export function emptyScores(now = Date.now(), cfg = CONFIG) {
  return { version: 1, createdAt: new Date(now).toISOString(), warmupEndsAt: new Date(now + cfg.whales.warmupDays * DAY).toISOString(), cursor: 0, whales: {} };
}

const entryOf = (s, venue, addr) => (s.whales[keyOf(venue, addr)] ??= { venue, addr: String(addr).toLowerCase(), prior: {}, cats: {} });

// Applique un score à une catégorie de baleine (copie modifiée de `cat`).
export function applyOutcome(cat, s, at, prior = 1, cfg = CONFIG) {
  const w = cfg.whales, c = cat ? { ...cat } : { n: 0, w: prior, cum: 0, peak: 0, maxDD: 0, lastAt: null };
  c.n += 1;
  c.w = clamp((1 - w.emaAlpha) * c.w + w.emaAlpha * (1 + s), w.weightMin, w.weightMax);
  c.cum += s; c.peak = Math.max(c.peak, c.cum); c.maxDD = Math.max(c.maxDD, c.peak - c.cum);
  c.lastAt = new Date(at).toISOString();
  return c;
}

// Traite les fermetures postérieures au curseur. resolutions : { cid → résolution } pour les marchés Polymarket.
export function updateScores(scores, events, { resolutions = {} } = {}, cfg = CONFIG) {
  const s = structuredClone(scores), applied = [], skipped = [];
  const fresh = events.filter((e) => e.t > s.cursor && e.kind === "close").sort((a, b) => a.t - b.t);
  for (const e of fresh) {
    const venue = e.src === "pm" ? "pm" : e.src === "hl" ? "hl" : null;
    const cat = venue === "hl" ? categoryOfHl(e.coin) : venue === "pm" ? categoryOfPm(e) : null;
    const sc = venue === "hl" ? scoreHlClose(e, cfg) : venue === "pm" ? scorePmClose(e, resolutions[e.cid]) : null;
    if (!venue || !e.addr || !cat || sc == null) { skipped.push({ t: e.t, addr: e.addr, why: !cat ? "hors catégorie" : "données incomplètes" }); continue; }
    const ent = entryOf(s, venue, e.addr);
    if (e.name) ent.name = e.name;
    ent.cats[cat] = applyOutcome(ent.cats[cat], sc, e.t, ent.prior[cat] ?? 1, cfg);
    applied.push({ t: e.t, key: keyOf(venue, e.addr), cat, score: sc, w: ent.cats[cat].w, n: ent.cats[cat].n });
  }
  if (events.length) s.cursor = Math.max(s.cursor, ...events.map((e) => e.t).filter(Number.isFinite));
  return { scores: s, applied, skipped };
}

/* ---------- poids de départ (PnL connu) ---------- */

// priors : { "hl:0x…": { crypto: 1.1, … } } ; une catégorie déjà notée garde son historique.
export function setPriors(scores, priors) {
  const s = structuredClone(scores);
  for (const [key, cats] of Object.entries(priors)) {
    const [venue, addr] = key.split(":");
    const ent = entryOf(s, venue, addr);
    ent.prior = { ...ent.prior, ...cats };
  }
  return s;
}

const priorFrom = (x, cfg) => clamp(1 + x * (cfg.whales.warmupMax - 1), cfg.whales.warmupMin, cfg.whales.warmupMax);

// Hyperliquid : ROI du mois (±50 % → bornes) ; le classement ne distingue pas les catégories.
export function priorsFromHl(rows, cfg = CONFIG) {
  const out = {};
  for (const r of rows || []) {
    if (!r?.addr) continue;
    const p = priorFrom(clamp((r.month?.roi ?? 0) / 0.5, -1, 1), cfg);
    out[keyOf("hl", r.addr)] = Object.fromEntries(cfg.whales.categories.map((c) => [c, p]));
  }
  return out;
}

// Polymarket : rang du PnL mensuel dans le classement de la catégorie (premier → 1,25 ; dernier → 0,75).
const PM_BOARD_CATS = { POLITICS: ["geopolitics"], CRYPTO: ["crypto"], FINANCE: ["macro", "commodities"] };
export function priorsFromPm(boards, cfg = CONFIG) {
  const out = {};
  for (const [board, cats] of Object.entries(PM_BOARD_CATS)) {
    const list = boards?.[board] || [];
    list.forEach((r, i) => {
      if (!r?.addr) return;
      const x = list.length > 1 ? 1 - (2 * i) / (list.length - 1) : 0;
      const k = keyOf("pm", r.addr);
      out[k] = { ...out[k], ...Object.fromEntries(cats.map((c) => [c, priorFrom(x, cfg)])) };
    });
  }
  return out;
}

/* ---------- lecture ---------- */

// Poids utilisable par les filtres. eligible = false → la baleine ne compte pas dans cette catégorie.
export function weightOf(scores, venue, addr, cat, now = Date.now(), cfg = CONFIG) {
  const w = cfg.whales, ent = scores.whales[keyOf(venue, addr)], c = ent?.cats?.[cat], prior = ent?.prior?.[cat] ?? 1;
  const n = c?.n ?? 0, warmupPhase = now < Date.parse(scores.warmupEndsAt);
  if (c && c.maxDD > w.maxCumDrawdown) return { w: c.w, n, warmup: n < w.minResolved, eligible: false, reason: `creux cumulé ${c.maxDD.toFixed(2)} > ${w.maxCumDrawdown}` };
  if (n >= w.minResolved) return { w: c.w, n, warmup: false, eligible: true, reason: null };
  const wb = clamp(c?.w ?? prior, w.warmupMin, w.warmupMax);
  return warmupPhase
    ? { w: wb, n, warmup: true, eligible: true, reason: null }
    : { w: wb, n, warmup: true, eligible: false, reason: `${n} positions résolues < ${w.minResolved}` };
}
