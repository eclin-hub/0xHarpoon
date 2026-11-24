// Détection des candidats (SPEC §3.2), sans LLM. Deux temps par cycle :
// 1. gather* : regroupe les positions des baleines par (actif, sens) ou (marché, option), écarte les baleines non
//    qualifiées et compte les entrées récentes (convergence). Ne demande aucune donnée réseau.
// 2. finalize* : avec les prix, l'ATR et le funding, applique fraîcheur, filtre contrariant et mur de liquidations,
//    puis calcule le score. Seuls les groupes qui passent l'étape 1 coûtent un appel réseau (ATR).
//
// Score = Σ poids des baleines entrées dans la fenêtre + 0,5 × Σ poids des baleines déjà en position,
//         × 1,2 si les baleines vont contre le funding, × (1 − 0,5 × distance / seuil de fraîcheur).
// Chaque candidat porte un bloc `metrics` de valeurs chiffrées : c'est là que les LLM doivent citer leurs objections.
import { CONFIG, factorOf } from "./config.mjs";
import { weightOf, categoryOfHl, categoryOfPm } from "./scorer.mjs";
import { recentEntries } from "./loader.mjs";

const H = 3600e3, DAY = 86400e3;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const pct = (x) => `${(x * 100).toFixed(1)} %`;
const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const lc = (a) => String(a || "").toLowerCase();

// |long − short| / (long + short) : proche de 0 = compte couvert (delta neutre)
export const netRatio = (a) => { const t = (a.longN || 0) + (a.shortN || 0); return t > 0 ? Math.abs((a.longN || 0) - (a.shortN || 0)) / t : 0; };
const windowH = (cat, cfg) => (cat === "macro" ? cfg.filters.convergenceWindowMacroH : cfg.filters.convergenceWindowH);

function tallyTriggers(groups, events, src, match, now, cfg) {
  for (const g of groups) {
    const since = now - windowH(g.category, cfg) * H;
    const entered = new Set(recentEntries(events, since, src).filter((e) => match(g, e)).map((e) => lc(e.addr)));
    for (const h of g.holders) h.trigger = entered.has(lc(h.addr));
    g.nTriggers = g.holders.filter((h) => h.trigger).length;
    g.nConfirm = g.holders.length - g.nTriggers;
    g.prescore = g.holders.reduce((s, h) => s + (h.trigger ? 1 : cfg.signals.confirmWeight) * h.w, 0);
  }
  const min = cfg.filters.convergenceMinWhales;
  return {
    pass: groups.filter((g) => g.nTriggers >= min).sort((a, b) => b.prescore - a.prescore),
    rejected: groups.filter((g) => g.nTriggers > 0 && g.nTriggers < min)
      .map((g) => ({ id: g.id, reason: `convergence : ${g.nTriggers} baleine qualifiée entrée en ${windowH(g.category, cfg)} h (minimum ${min})` })),
    all: groups,
  };
}

/* ---------------- Hyperliquid ---------------- */

export function gatherHl(snap, scores, now = Date.now(), cfg = CONFIG) {
  const f = cfg.filters, groups = new Map();
  for (const a of snap.hl) {
    if (a.error) continue;
    const hedged = netRatio(a) < f.hedgeMinNetRatio;
    for (const p of a.positions) {
      const cat = categoryOfHl(p.coin);
      if (!cat || !(p.notional > 0)) continue;
      const id = `hl|${p.coin}|${p.side}`;
      const g = groups.get(id) ?? { id, venue: "hl", coin: p.coin, side: p.side, category: cat, factor: factorOf(p.coin), holders: [], excluded: [] };
      const share = a.equity > 0 ? p.notional / a.equity : 0, w = weightOf(scores, "hl", a.addr, cat, now, cfg);
      const why = hedged ? `compte couvert (ratio net ${netRatio(a).toFixed(2)})` : !w.eligible ? w.reason
        : share < f.minPositionShareOfEquity ? `position = ${pct(share)} de l'equity` : null;
      (why ? g.excluded : g.holders).push({ addr: a.addr, w: w.w, n: w.n, warmup: w.warmup, share, entry: p.entry, notional: p.notional, why });
      groups.set(id, g);
    }
  }
  return tallyTriggers([...groups.values()], snap.events, "hl", (g, e) => e.coin === g.coin && e.side === g.side, now, cfg);
}

// Notionnel de la cohorte (toutes baleines) liquidé à moins de liqWallAtr × ATR du prix, dans le sens du trade.
export function liquidationWall(accounts, coin, side, mark, atr, cfg = CONFIG) {
  let total = 0, wall = 0;
  const band = cfg.signals.liqWallAtr * atr;
  for (const a of accounts) for (const p of a.positions || []) {
    if (p.coin !== coin || p.side !== side) continue;
    total += p.notional || 0;
    if (p.liq > 0 && (side === "long" ? p.liq >= mark - band && p.liq <= mark : p.liq <= mark + band && p.liq >= mark)) wall += p.notional || 0;
  }
  return { total, wall, share: total > 0 ? wall / total : 0 };
}

export function finalizeHl(g, { markets = {}, ohlc = {} } = {}, accounts = [], cfg = CONFIG) {
  const m = markets[g.coin], o = ohlc[g.coin], s = cfg.signals, k = cfg.filters.hlFreshAtrMult;
  if (!(m?.mark > 0) || !(o?.atr > 0)) return { ok: false, id: g.id, reason: "prix ou ATR manquant" };
  let wn = 0, ww = 0;
  for (const h of g.holders) if (h.entry > 0) { wn += h.entry * h.notional; ww += h.notional; }
  if (!ww) return { ok: false, id: g.id, reason: "prix d'entrée des baleines inconnu" };
  const vwap = wn / ww, mark = m.mark, atr = o.atr;
  const dist = (g.side === "long" ? mark - vwap : vwap - mark) / atr;   // > 0 : le prix est déjà parti dans le sens du trade
  if (dist > k) return { ok: false, id: g.id, reason: `fraîcheur : prix à ${dist.toFixed(2)} ATR de l'entrée des baleines (max ${k})` };
  const funding = m.funding || 0, paid = g.side === "long" ? funding : -funding;   // > 0 : le sens du trade paie le funding
  const liq = liquidationWall(accounts, g.coin, g.side, mark, atr, cfg);
  if (paid >= s.fundingExtreme && liq.share >= s.liqWallShare)
    return { ok: false, id: g.id, reason: `trade encombré : funding ${(funding * 100).toFixed(4)} %/h et ${pct(liq.share)} de la cohorte liquidable à moins de ${s.liqWallAtr} ATR` };
  const contrarian = g.side === "long" ? funding <= 0 : funding >= s.fundingHigh;
  const score = g.prescore * (contrarian ? 1 + s.contrarianBonus : 1) * (1 - 0.5 * Math.max(0, dist) / k);
  return { ok: true, cand: {
    id: g.id, type: "whale", venue: "hl", coin: g.coin, side: g.side, category: g.category, factor: g.factor, pocket: "core", score: r4(score),
    metrics: { mark: r4(mark), whales_vwap_entry: r4(vwap), dist_atr: r4(dist), atr14: r4(atr), atr_pct: r4(o.atrPct), funding_h: funding,
      funding_apr: r4(funding * 24 * 365), contrarian, liq_wall_share: r4(liq.share), open_interest_usd: Math.round(m.oi || 0),
      n_triggers: g.nTriggers, n_confirm: g.nConfirm, whales_notional_usd: Math.round(ww),
      avg_share_of_equity: r4(g.holders.reduce((a, h) => a + h.share, 0) / g.holders.length) },
    whales: g.holders.map((h) => ({ addr: shortAddr(h.addr), w: r4(h.w), n: h.n, warmup: h.warmup, trigger: h.trigger, share: r4(h.share), entry: r4(h.entry) })),
  } };
}

/* ---------------- Polymarket ---------------- */

export function gatherPm(snap, scores, now = Date.now(), cfg = CONFIG) {
  const f = cfg.filters, groups = new Map();
  for (const wh of snap.pm) {
    const total = wh.positions.reduce((s, p) => s + (p.value || 0), 0);
    for (const p of wh.positions) {
      const cat = categoryOfPm(p);
      if (!cat || !p.cid || !(p.value > 0)) continue;
      const id = `pm|${p.cid}|${p.outcome}`;
      const g = groups.get(id) ?? { id, venue: "pm", cid: p.cid, outcome: p.outcome, token: p.token ?? null, title: p.title, end: p.end ?? null, category: cat, holders: [], excluded: [] };
      g.token ??= p.token ?? null; g.price = p.price;
      const share = total > 0 ? p.value / total : 0, w = weightOf(scores, "pm", wh.addr, cat, now, cfg);
      const why = !w.eligible ? w.reason : share < f.minPositionShareOfEquity ? `position = ${pct(share)} du portefeuille` : null;
      (why ? g.excluded : g.holders).push({ addr: wh.addr, w: w.w, n: w.n, warmup: w.warmup, share, avg: p.avg, value: p.value, why });
      groups.set(id, g);
    }
  }
  return tallyTriggers([...groups.values()], snap.events, "pm", (g, e) => e.cid === g.cid && e.outcome === g.outcome, now, cfg);
}

export function finalizePm(g, now = Date.now(), cfg = CONFIG) {
  const pp = cfg.pockets.portage, price = g.price;
  if (!g.token) return { ok: false, id: g.id, reason: "jeton inconnu (relevé antérieur à la mise à jour de pm.mjs)" };
  if (!(price > 0 && price < 1)) return { ok: false, id: g.id, reason: "prix inconnu" };
  let vn = 0, vw = 0;
  for (const h of g.holders) if (h.avg > 0) { vn += h.avg * h.value; vw += h.value; }
  if (!vw) return { ok: false, id: g.id, reason: "prix moyen des baleines inconnu" };
  const avg = vn / vw, delta = price - avg;
  if (delta > cfg.filters.pmFreshMaxDelta) return { ok: false, id: g.id, reason: `fraîcheur : cote ${price} à +${delta.toFixed(3)} $ du prix moyen des baleines (max ${cfg.filters.pmFreshMaxDelta})` };
  if (price > pp.maxPrice) return { ok: false, id: g.id, reason: `cote ${price} > ${pp.maxPrice} : plus assez d'avantage` };
  const days = g.end ? (Date.parse(g.end) - now) / DAY : null;
  const pocket = price >= pp.minPrice && days != null && days >= 0 && days <= pp.maxDays ? "portage" : "core";
  const score = g.prescore * (1 - 0.5 * Math.max(0, delta) / cfg.filters.pmFreshMaxDelta);
  return { ok: true, cand: {
    id: g.id, type: "whale", venue: "pm", cid: g.cid, token: g.token, outcome: g.outcome, title: g.title, category: g.category, pocket, score: r4(score),
    metrics: { price, whales_avg_price: r4(avg), delta_vs_whales: r4(delta), days_to_end: r4(days), end: g.end, implied_prob: price,
      n_triggers: g.nTriggers, n_confirm: g.nConfirm, whales_value_usd: Math.round(vw),
      avg_share_of_portfolio: r4(g.holders.reduce((a, h) => a + h.share, 0) / g.holders.length) },
    whales: g.holders.map((h) => ({ addr: shortAddr(h.addr), w: r4(h.w), n: h.n, warmup: h.warmup, trigger: h.trigger, share: r4(h.share), avg: r4(h.avg) })),
  } };
}

/* ---------------- dossier ---------------- */

// Garde les maxCandidates meilleurs ; un candidat déjà en portefeuille (même actif et sens, ou même marché) est écarté.
export function selectCandidates(list, portfolio, cfg = CONFIG) {
  const held = new Set(portfolio.positions.map((q) => (q.venue === "hl" ? `hl|${q.coin}|${q.side}` : `pm|${q.cid}|${q.outcome}`)));
  const legs = (c) => (c.type === "pair" ? [`hl|${c.long.coin}|long`, `hl|${c.short.coin}|short`] : [c.type === "leadlag" ? `hl|${c.coin}|${c.side}` : c.id]);
  const rejected = [], kept = [];
  for (const c of [...list].sort((a, b) => b.score - a.score)) {
    if (legs(c).some((k) => held.has(k))) { rejected.push({ id: c.id, reason: "déjà en portefeuille" }); continue; }
    if (kept.length >= cfg.filters.maxCandidates) { rejected.push({ id: c.id, reason: `hors des ${cfg.filters.maxCandidates} meilleurs` }); continue; }
    kept.push(c);
  }
  return { candidates: kept, rejected, wakeLLM: kept.some((c) => c.score >= cfg.signals.minScore) };
}
