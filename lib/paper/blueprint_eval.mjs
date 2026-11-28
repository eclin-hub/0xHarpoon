// Évaluation d'un Blueprint (blueprint.mjs) sur des séries de prix, synthétiques (Division 1) ou réelles (Divisions 2 et 3).
// Un seul moteur pour les deux : une stratégie est jugée de la même façon au labo et en live.
//   series d'un ticker : { t[], c[], h[], l[], funding[], xVel[], xBias[], pm[] } — une barre par heure.
//   Score à la barre i : moyenne pondérée des signaux des blocs (−1 à +1) ; volatility_regime est un filtre (0 ou 1).
//   Carnet : une position au plus par ticker, risque fixe par trade au stop (stop_atr × ATR), objectif take_profit_atr × ATR,
//   durée maximale, sortie sur signal contraire ; frais taker et glissement à l'entrée comme à la sortie.
import { psr as psrOf } from "./metrics.mjs";
import { assetClass } from "./universe.mjs";

export const SIM = Object.freeze({
  fee: 0.00035,          // frais taker Hyperliquid, par côté
  slippage: 0.0003,      // glissement moyen par côté (3 points de base)
  riskPerTrade: 0.01,    // 1 % de l'équité risqué au stop (stop_atr × ATR), comme le livre principal
  // plafonds (sur le capital virtuel de départ, 10 000 $ en D2/D3) : par position 15 % (1 500 $), exposition brute 60 %
  // (6 000 $), 4 positions à la fois, 3 positions du même sens par classe d'actifs (crypto, tradfi, pm) ; famille
  // stat_arb_leadlag : pas de 3e jambe dans un sens sans au moins une jambe en sens inverse dans la même classe.
  maxNotional: 0.15, maxGross: 0.6, maxPositions: 4, maxSameDirPerClass: 3, statArbUnhedged: 2,
  atrPeriod: 14,
  barsPerYear: 8760,     // barres horaires
  curveMax: 720,         // points de courbe gardés en live (30 jours)
});

const clip = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const memo = new WeakMap();
const cached = (s, key, fn) => { let m = memo.get(s); if (!m) memo.set(s, (m = new Map())); if (!m.has(key)) m.set(key, fn()); return m.get(key); };

/* ---------------- indicateurs (tableaux complets, calculés une fois par série) ---------------- */

function rolling(values, n) {   // moyenne et écart-type glissants
  const mean = new Array(values.length).fill(null), sd = new Array(values.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0; s += v; s2 += v * v;
    if (i >= n) { const o = values[i - n] ?? 0; s -= o; s2 -= o * o; }
    if (i >= n - 1) { const m = s / n; mean[i] = m; sd[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); }
  }
  return { mean, sd };
}
const logRet = (s) => cached(s, "ret", () => s.c.map((c, i) => (i ? Math.log(c / s.c[i - 1]) : 0)));
const retSd = (s) => cached(s, "retSd", () => rolling(logRet(s), 50).sd);
const atrArr = (s, n = SIM.atrPeriod) => cached(s, `atr${n}`, () => {
  const out = new Array(s.c.length).fill(null); let a = null, sum = 0;
  for (let i = 1; i < s.c.length; i++) {
    const h = s.h?.[i] ?? s.c[i], l = s.l?.[i] ?? s.c[i], pc = s.c[i - 1];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= n) { sum += tr; if (i === n) a = sum / n; } else a = (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
});
const rsiArr = (s, n) => cached(s, `rsi${n}`, () => {
  const out = new Array(s.c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < s.c.length; i++) {
    const d = s.c[i] - s.c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; } } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
});
const bandArr = (s, n) => cached(s, `bb${n}`, () => rolling(s.c, n));

/* ---------------- signaux des blocs ---------------- */

const momentumAt = (s, i, L) => { if (i < L || !retSd(s)[i]) return null; return Math.tanh(Math.log(s.c[i] / s.c[i - L]) / (retSd(s)[i] * Math.sqrt(L))); };
const zAt = (s, i, n) => { const b = bandArr(s, n); return b.sd[i] ? (s.c[i] - b.mean[i]) / b.sd[i] : null; };

// → nombre (−1 à 1), null (historique insuffisant) ; volatility_regime → { gate: 0 | 1 }
export function blockSignal(b, s, i) {
  const p = b.params || {};
  switch (b.type) {
    case "momentum": return momentumAt(s, i, Math.round(p.lookback ?? 20));
    case "rsi": {
      const r = rsiArr(s, Math.round(p.period ?? 14))[i], lo = p.low ?? 30, hi = p.high ?? 70;
      if (r == null) return null;
      return r < lo ? clip(2 * (lo - r) / lo) : r > hi ? clip(-2 * (r - hi) / (100 - hi)) : 0;   // retour à la moyenne
    }
    case "bollinger_zscore": { const z = zAt(s, i, Math.round(p.period ?? 20)); return z == null ? null : clip(-z / (p.z ?? 2)); }
    case "atr_breakout": {
      const n = Math.round(p.period ?? 14), a = atrArr(s, n)[i];
      if (i < n || !a) return null;
      return clip((s.c[i] - s.c[i - n]) / ((p.mult ?? 1.5) * a * Math.sqrt(n)));
    }
    case "volatility_regime": {
      const a = atrArr(s)[i];
      return a == null ? null : { gate: a / s.c[i] <= (p.max_atr_pct ?? 0.05) ? 1 : 0 };
    }
    case "x_velocity_bias": {
      const v = s.xVel?.[i] ?? 1, bias = s.xBias?.[i] ?? 0, mv = p.min_velocity ?? 2, mb = Math.abs(p.min_bias ?? 0.2);
      return v >= mv && Math.abs(bias) >= mb ? Math.sign(bias) * Math.min(1, v / (2 * mv)) : 0;
    }
    case "polymarket_edge": {
      const m = s.pm?.[i] ?? 0, mm = p.min_move ?? 0.1;
      return Math.abs(m) >= mm ? Math.sign(m) * Math.min(1, Math.abs(m) / (2 * mm)) : 0;
    }
    case "linear_ml_score": {
      const f = { momentum: momentumAt(s, i, 20), rsi: rsiArr(s, 14)[i] == null ? null : (rsiArr(s, 14)[i] - 50) / 50, zscore: zAt(s, i, 20) == null ? null : clip(zAt(s, i, 20) / 3),
        atr_pct: atrArr(s)[i] == null ? null : clip(atrArr(s)[i] / s.c[i] / 0.05, 0, 1), funding: clip((s.funding?.[i] ?? 0) / 0.0005), x_bias: s.xBias?.[i] ?? 0,
        x_velocity: clip(((s.xVel?.[i] ?? 1) - 1) / 3), pm_move: clip((s.pm?.[i] ?? 0) / 0.2) };
      let z = p.intercept ?? 0;
      for (let k = 0; k < (p.features || []).length; k++) { const v = f[p.features[k]]; if (v == null) return null; z += (p.coefs[k] ?? 0) * v; }
      return Math.tanh(z);
    }
    default: return null;
  }
}

// Score combiné (−1 à 1) d'un Blueprint sur un ticker à la barre i ; null si aucun bloc n'a assez d'historique.
export function scoreAt(bp, s, i) {
  let num = 0, den = 0, any = false, gate = 1;
  for (const b of bp.blocks) {
    const v = blockSignal(b, s, i);
    if (v && typeof v === "object") { gate *= v.gate; continue; }
    den += Math.abs(b.weight);
    if (v == null) continue;
    any = true; num += b.weight * v;
  }
  return any && den > 0 ? clip(num / den) * gate : null;
}

/* ---------------- carnet de trading ---------------- */

export const newBook = (capital = 10_000) => ({ capital, cash: capital, equity: capital, peak: capital, maxDD: 0, positions: {}, trades: [], curve: [], returns: [], lastT: null });

const allows = (side, dir) => side === "both" || (side === "long" ? dir > 0 : dir < 0);

function closePos(book, T, pos, px, reason, t, cfg) {
  const exit = px * (1 - pos.dir * cfg.slippage), fee = Math.abs(pos.qty * exit) * cfg.fee;
  const pnl = pos.dir * pos.qty * (exit - pos.entry) - fee - pos.fee;
  book.cash += pos.dir * pos.qty * (exit - pos.entry) - fee;
  book.trades.push({ T, side: pos.dir > 0 ? "long" : "short", entry: pos.entry, exit, pnl, ret: pnl / pos.equity0, bars: pos.bars, reason, tOpen: pos.t0, tClose: t });
  delete book.positions[T];
}

// Réduction partielle d'une position au prix px (frais et glissement sur la part vendue) ; trade « reduce » journalisé
function reducePos(book, T, pos, newQty, px, reason, t, cfg) {
  const q = pos.qty - newQty;
  if (!(q > 0)) return;
  const exit = px * (1 - pos.dir * cfg.slippage), fee = Math.abs(q * exit) * cfg.fee, feeShare = pos.fee * (q / pos.qty);
  const pnl = pos.dir * q * (exit - pos.entry) - fee - feeShare;
  book.cash += pos.dir * q * (exit - pos.entry) - fee;
  book.trades.push({ T, side: pos.dir > 0 ? "long" : "short", entry: pos.entry, exit, pnl, ret: pnl / pos.equity0, bars: pos.bars, reason, tOpen: pos.t0, tClose: t, partial: true, qty: q });
  pos.fee -= feeShare; pos.qty = newQty;
}

// Mise aux plafonds d'un carnet déjà ouvert (positions prises sous d'anciennes règles), au dernier prix :
//   1. chaque position ramenée à maxNotional × capital (réduction partielle) ;
//   2. positions en excès fermées, les plus récentes d'abord : plus de maxPositions, plus de maxSameDirPerClass dans un
//      sens et une classe, ou (stat_arb_leadlag) plus de statArbUnhedged jambes dans un sens sans jambe inverse ;
//   3. exposition brute encore au-dessus de maxGross × capital : toutes les positions réduites au prorata.
// → nombre d'actions effectuées (0 si le carnet respecte déjà les plafonds).
export function enforceCaps(book, bp, market, iOf, t, cfg = SIM) {
  const pxOf = (T, pos) => { const s = market[T], i = typeof iOf === "function" ? iOf(T) : iOf; return s?.c?.[i] ?? pos.entry; };
  const cap = Math.min(book.capital ?? book.equity, book.equity);
  let n = 0;
  for (const [T, pos] of Object.entries(book.positions)) {
    const px = pxOf(T, pos), max = (cfg.maxNotional * cap) / px;
    if (pos.qty > max * 1.01) {   // tolérance de 1 % : pas de micro-réductions à chaque variation de l'équité
      reducePos(book, T, pos, max, px, "plafond de taille", t, cfg); n++; }
  }
  const tooMany = () => {
    const open = Object.entries(book.positions);
    if (open.length > (cfg.maxPositions ?? Infinity)) return true;
    for (const [K, q] of open) {
      const cls = assetClass(K), same = open.filter(([X, p]) => p.dir === q.dir && assetClass(X) === cls).length, opp = open.filter(([X, p]) => p.dir === -q.dir && assetClass(X) === cls).length;
      if (same > (cfg.maxSameDirPerClass ?? Infinity) || (bp?.family === "stat_arb_leadlag" && same > (cfg.statArbUnhedged ?? Infinity) && opp === 0)) return [K, q.dir, cls];
    }
    return false;
  };
  for (let guard = 0, v = tooMany(); v && guard < 50; guard++, v = tooMany()) {
    // la plus récente parmi les positions en cause (tout le carnet si c'est le nombre total qui dépasse)
    const cands = Object.entries(book.positions).filter(([K, q]) => v === true || (q.dir === v[1] && assetClass(K) === v[2]));
    const [T, pos] = cands.sort((a, b) => (b[1].t0 ?? 0) - (a[1].t0 ?? 0))[0];
    closePos(book, T, pos, pxOf(T, pos), "plafond de concentration", t, cfg); n++;
  }
  const gross = Object.entries(book.positions).reduce((a, [T, q]) => a + q.qty * pxOf(T, q), 0), maxG = (cfg.maxGross ?? Infinity) * cap;
  if (gross > maxG * 1.01) for (const [T, pos] of Object.entries(book.positions)) { reducePos(book, T, pos, pos.qty * (maxG / gross), pxOf(T, pos), "plafond d'exposition", t, cfg); n++; }
  // valorisation après mise aux plafonds
  let eq = book.cash;
  for (const [T, pos] of Object.entries(book.positions)) eq += pos.dir * pos.qty * (pxOf(T, pos) - pos.entry);
  book.equity = eq; book.peak = Math.max(book.peak, eq); book.maxDD = Math.max(book.maxDD, 1 - eq / book.peak);
  return n;
}

// Avance d'une barre. market : { TICKER: series } ; iOf(T) : indice de la barre courante de ce ticker ; t : horodatage.
// gate(T, dir, s, i) → 0 interdit une nouvelle ouverture (régime macro, regime_agent.mjs) ; les sorties ne sont jamais bloquées.
export function stepBook(book, bp, market, iOf, t, cfg = SIM, gate = null) {
  const ex = bp.exit, en = bp.entry.score_above, start = book.equity;
  for (const T of bp.universe) {
    const s = market[T], i = typeof iOf === "function" ? iOf(T) : iOf;
    if (!s || i == null || i < 1 || !(s.c[i] > 0)) continue;
    const px = s.c[i], hi = s.h?.[i] ?? px, lo = s.l?.[i] ?? px, pos = book.positions[T];
    const score = scoreAt(bp, s, i);
    if (pos) {
      pos.bars++;
      const hitStop = pos.dir > 0 ? lo <= pos.stop : hi >= pos.stop, hitTp = pos.tp != null && (pos.dir > 0 ? hi >= pos.tp : lo <= pos.tp);
      if (hitStop) closePos(book, T, pos, pos.stop, "stop", t, cfg);
      else if (hitTp) closePos(book, T, pos, pos.tp, "objectif", t, cfg);
      else if (pos.bars >= ex.max_hold_hours) closePos(book, T, pos, px, "durée", t, cfg);
      else if (score != null && score * pos.dir < -en) closePos(book, T, pos, px, "signal contraire", t, cfg);
      continue;   // pas de réouverture sur la barre de sortie
    }
    if (score == null || Math.abs(score) <= en) continue;
    const dir = Math.sign(score), a = atrArr(s, cfg.atrPeriod)[i];
    if (!allows(bp.side, dir) || !(a > 0)) continue;
    if (gate && !(gate(T, dir, s, i) > 0)) { book.gated = (book.gated || 0) + 1; continue; }   // famille coupée par le régime
    // plafonds de nombre et de direction (concentration) : refus comptés dans book.capped
    const open = Object.entries(book.positions), cls = assetClass(T);
    const same = open.filter(([K, q]) => q.dir === dir && assetClass(K) === cls).length, opp = open.filter(([K, q]) => q.dir === -dir && assetClass(K) === cls).length;
    if (open.length >= (cfg.maxPositions ?? Infinity) || same >= (cfg.maxSameDirPerClass ?? Infinity)
      || (bp.family === "stat_arb_leadlag" && same >= (cfg.statArbUnhedged ?? Infinity) && opp === 0)) { book.capped = (book.capped || 0) + 1; continue; }
    const entry = px * (1 + dir * cfg.slippage), stopDist = ex.stop_atr * a, cap = Math.min(book.capital ?? book.equity, book.equity);
    const gross = open.reduce((acc, [K, q]) => acc + q.qty * (market[K]?.c?.[typeof iOf === "function" ? iOf(K) : iOf] ?? q.entry), 0);
    const room = (cfg.maxGross ?? Infinity) * cap - gross;
    const qty = Math.min((cfg.riskPerTrade * book.equity) / stopDist, (cfg.maxNotional * cap) / entry, Math.max(0, room) / entry);
    if (!(qty > 0)) continue;
    const fee = qty * entry * cfg.fee;
    book.cash -= fee;
    book.positions[T] = { dir, qty, entry, fee, stop: entry - dir * stopDist, tp: ex.take_profit_atr ? entry + dir * ex.take_profit_atr * a : null, bars: 0, t0: t, equity0: book.equity };
  }
  // valorisation
  let eq = book.cash;
  for (const [T, pos] of Object.entries(book.positions)) { const s = market[T], i = typeof iOf === "function" ? iOf(T) : iOf; eq += pos.dir * pos.qty * ((s?.c[i] ?? pos.entry) - pos.entry); }
  book.equity = eq; book.peak = Math.max(book.peak, eq); book.maxDD = Math.max(book.maxDD, 1 - eq / book.peak);
  book.curve.push([t, Math.round(eq * 100) / 100]); book.returns.push([t, start > 0 ? eq / start - 1 : 0]); book.lastT = t;
  if (book.curve.length > cfg.curveMax) { book.curve.splice(0, book.curve.length - cfg.curveMax); book.returns.splice(0, book.returns.length - cfg.curveMax); }
  return book;
}

export function closeAll(book, market, iOf, t, cfg = SIM) {
  for (const [T, pos] of Object.entries(book.positions)) { const s = market[T], i = typeof iOf === "function" ? iOf(T) : iOf; closePos(book, T, pos, s.c[i], "fin du test", t, cfg); }
  book.equity = book.cash; return book;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// Métriques d'un ensemble de trades (et d'une suite de rendements par barre pour le Sharpe).
export function tradeMetrics(trades, barReturns = [], cfg = SIM) {
  const pnl = trades.map((x) => x.pnl), wins = pnl.filter((x) => x > 0), losses = pnl.filter((x) => x < 0);
  const gl = -losses.reduce((a, b) => a + b, 0), gw = wins.reduce((a, b) => a + b, 0);
  const r = barReturns.filter(Number.isFinite), sd = r.length > 2 ? sdOf(r) : 0;
  return { trades: trades.length, winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? 99 : null, psr: trades.length >= 3 ? psrOf(trades.map((x) => x.ret)) : null,
    sharpe: sd > 0 ? (mean(r) / sd) * Math.sqrt(cfg.barsPerYear) : null };
}

export function bookMetrics(book, cfg = SIM) {
  return { ...tradeMetrics(book.trades, book.returns.map(([, r]) => r), cfg), maxDrawdown: book.maxDD, equity: book.equity, totalReturn: book.equity / book.capital - 1 };
}

// Corrélation de deux suites de rendements horodatés [[t, r]…] sur leurs dates communes (null si moins de 10 points).
export function returnCorrelation(a, b) {
  const mb = new Map(b.map(([t, r]) => [t, r])), xs = [], ys = [];
  for (const [t, r] of a) if (mb.has(t)) { xs.push(r); ys.push(mb.get(t)); }
  if (xs.length < 10) return null;
  const mx = mean(xs), my = mean(ys);
  let c = 0, vx = 0, vy = 0;
  for (let k = 0; k < xs.length; k++) { c += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; vy += (ys[k] - my) ** 2; }
  return vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : null;
}
