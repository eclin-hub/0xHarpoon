// Signaux entre actifs (SPEC §3.3).
//
// Paires neutres : un candidat Hyperliquid A qui a passé tous les filtres, porté par des baleines nettement d'un côté
// (sentiment ≥ 0,6), et un actif B du même facteur, corrélé (ρ > 0,6 sur 30 rendements quotidiens), sur lequel ces
// mêmes baleines qualifiées sont neutres ou de l'autre côté (sentiment ≤ 0,2) → « long A / short B » (ou l'inverse).
// Sentiment d'un actif = (L − S) / (L + S), L et S = notionnels pondérés par les poids des baleines qualifiées.
//
// Décalage Polymarket → Hyperliquid : on garde un historique court (48 h) des cotes des marchés Polymarket liés à un
// actif (pétrole, or, BTC…) et des prix mark. Si une cote bouge de ≥ 10 points en ≤ 2 h et que l'actif n'a pas suivi
// (mouvement de même sens d'au moins 0,25 ATR quotidien), on crée un candidat prioritaire dans le sens impliqué.
// Limite : le cycle est horaire, une fenêtre de 2 h contient donc 2 ou 3 relevés.
import { CONFIG, factorOf } from "./config.mjs";
import { categoryOfHl } from "./scorer.mjs";
import { TOPIC_COIN } from "../topics.mjs";

const H = 3600e3;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/* ---------------- paires ---------------- */

export function coinSentiment(groups) {
  const out = {};
  for (const g of groups) {
    if (g.venue !== "hl") continue;
    const e = (out[g.coin] ??= { L: 0, S: 0 });
    const n = g.holders.reduce((s, h) => s + h.w * h.notional, 0);
    if (g.side === "long") e.L += n; else e.S += n;
  }
  for (const e of Object.values(out)) e.s = e.L + e.S > 0 ? (e.L - e.S) / (e.L + e.S) : 0;
  return out;
}

// Corrélation des rendements logarithmiques quotidiens, alignés par date. closes : [[t, prix]…]
export function correlation(a, b, days = 30) {
  const mb = new Map((b || []).map(([t, c]) => [Math.floor(t / 86400e3), c]));
  const pairs = [];
  for (const [t, c] of a || []) { const v = mb.get(Math.floor(t / 86400e3)); if (v > 0 && c > 0) pairs.push([c, v]); }
  const ra = [], rb = [];
  for (let i = 1; i < pairs.length; i++) { ra.push(Math.log(pairs[i][0] / pairs[i - 1][0])); rb.push(Math.log(pairs[i][1] / pairs[i - 1][1])); }
  const x = ra.slice(-days), y = rb.slice(-days);
  if (x.length < 12) return null;
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < x.length; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
}

// Actifs candidats pour l'autre jambe : même facteur (hors IDIOSYNCRATIC, sans corrélation exploitable a priori).
export function partnersOf(coin, cfg = CONFIG) {
  const f = factorOf(coin);
  return f === "IDIOSYNCRATIC" ? [] : cfg.factors[f].filter((c) => c !== coin);
}

export function findPairs(hlCands, sentiment, ohlc, markets, cfg = CONFIG) {
  const s = cfg.signals, out = [];
  for (const a of hlCands) {
    const sa = sentiment[a.coin]?.s ?? 0, dir = a.side === "long" ? 1 : -1;
    if (dir * sa < s.pairStrong) continue;
    let best = null;
    for (const b of partnersOf(a.coin, cfg)) {
      const sb = sentiment[b]?.s ?? 0;
      if (dir * sb > s.pairNeutral) continue;
      const rho = correlation(ohlc[a.coin]?.closes, ohlc[b]?.closes, s.corrDays);
      if (rho == null || rho <= s.pairMinCorr || !(markets[b]?.mark > 0) || !(ohlc[b]?.atr > 0)) continue;
      if (!best || rho > best.rho) best = { coin: b, rho, sb };
    }
    if (!best) continue;
    const [lo, sh] = dir > 0 ? [a.coin, best.coin] : [best.coin, a.coin];
    const leg = (c) => ({ coin: c, mark: r4(markets[c]?.mark), atr14: r4(ohlc[c]?.atr), atr_pct: r4(ohlc[c]?.atrPct), whale_sentiment: r4(sentiment[c]?.s ?? 0) });
    out.push({ id: `pair|${lo}|${sh}`, type: "pair", venue: "hl", category: a.category, factor: factorOf(a.coin), pocket: "core",
      long: { coin: lo }, short: { coin: sh }, score: r4(a.score * best.rho), from: a.id,
      metrics: { rho_30d: r4(best.rho), long_leg: leg(lo), short_leg: leg(sh), source_score: a.score } });
  }
  return out;
}

/* ---------------- décalage Polymarket → Hyperliquid ---------------- */

export const emptyHistory = () => ({ pm: {}, hl: {} });

// Ajoute les cotes des marchés liés à un actif (positions des baleines du relevé) et les prix mark correspondants.
export function updateHistory(history, snap, markets, now = Date.now(), cfg = CONFIG) {
  const h = structuredClone(history || emptyHistory()), keep = now - cfg.signals.historyKeepH * H, coins = new Set();
  const seen = new Set();
  for (const w of snap.pm || []) for (const p of w.positions || []) {
    const coin = p.topic ? TOPIC_COIN[p.topic] : null;
    if (!coin || p.view == null || !p.cid || !(p.price > 0)) continue;
    const k = `${p.cid}|${p.outcome}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const e = (h.pm[k] ??= { coin, view: p.view, title: p.title, cid: p.cid, outcome: p.outcome, pts: [] });
    if (e.pts.at(-1)?.[0] !== now) e.pts.push([now, p.price]);
    coins.add(coin);
  }
  for (const c of coins) if (markets[c]?.mark > 0) (h.hl[c] ??= []).push([now, markets[c].mark]);
  for (const [k, e] of Object.entries(h.pm)) { e.pts = e.pts.filter(([t]) => t >= keep); if (!e.pts.length) delete h.pm[k]; }
  for (const [c, pts] of Object.entries(h.hl)) { h.hl[c] = pts.filter(([t]) => t >= keep); if (!h.hl[c].length) delete h.hl[c]; }
  return h;
}

const at = (pts, t) => { let best = null; for (const p of pts) if (p[0] <= t) best = p; return best; };

// Marchés dont la cote a bougé d'au moins leadLagMinMove dans la fenêtre (avant de demander l'ATR des actifs liés).
export function movedMarkets(history, now = Date.now(), cfg = CONFIG) {
  const s = cfg.signals, from = now - s.leadLagWindowH * H, out = [];
  for (const e of Object.values(history.pm)) {
    const win = e.pts.filter(([t]) => t >= from);
    if (win.length < 2) continue;
    const dP = win.at(-1)[1] - win[0][1];
    if (Math.abs(dP) >= s.leadLagMinMove - 1e-9) out.push({ ...e, dP, t0: win[0][0], t1: win.at(-1)[0] });
  }
  return out;
}

export function detectLeadLag(history, ohlc, now = Date.now(), cfg = CONFIG) {
  const s = cfg.signals, out = [], rejected = [];
  for (const m of movedMarkets(history, now, cfg)) {
    const implied = Math.sign(m.view * m.dP), pts = history.hl[m.coin] || [], p0 = at(pts, m.t0), p1 = at(pts, m.t1), o = ohlc[m.coin];
    const id = `leadlag|${m.cid}|${m.outcome}`;
    if (!p0 || !p1 || !(o?.atrPct > 0)) { rejected.push({ id, reason: "prix de l'actif ou ATR manquant sur la fenêtre" }); continue; }
    const r = p1[1] / p0[1] - 1, need = s.leadLagReactAtr * o.atrPct;
    if (Math.sign(r) === implied && Math.abs(r) >= need) { rejected.push({ id, reason: `actif déjà réactif (${(r * 100).toFixed(2)} %)` }); continue; }
    out.push({ id, type: "leadlag", venue: "hl", coin: m.coin, side: implied > 0 ? "long" : "short", category: categoryOfHl(m.coin), factor: factorOf(m.coin), pocket: "core",
      score: s.leadLagScore, metrics: { pm_title: m.title, pm_outcome: m.outcome, pm_move: r4(m.dP), window_min: Math.round((m.t1 - m.t0) / 60000),
        asset_move: r4(r), reaction_needed: r4(implied * need), atr_pct: r4(o.atrPct), mark: r4(p1[1]) } });
  }
  return { candidates: out, rejected };
}
