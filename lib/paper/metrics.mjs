// Évaluation (SPEC §7). Fonctions pures sur la courbe de capital (equity_curve.jsonl) et le journal (trades_history.jsonl).
//
// - Rendements quotidiens : dernier point de chaque jour UTC ; annualisation sur 365 jours (marchés ouverts en continu).
// - Sharpe = moyenne / écart-type × √365 ; Sortino = moyenne / écart à la baisse × √365 ; Calmar = rendement annualisé / drawdown max.
// - Drawdown max calculé sur tous les points (horaires), pas seulement les clôtures quotidiennes.
// - PSR (Bailey et López de Prado) : probabilité que le vrai Sharpe dépasse 0, compte tenu de l'asymétrie et de
//   l'aplatissement des rendements et du nombre d'observations.
// - Brier (Polymarket) : la conviction retenue (0 – 100) est lue comme la probabilité que le pari gagne ;
//   comparé au Brier du marché (prix d'entrée). Seuls les marchés résolus comptent.
// - Significativité : signalée à partir de 30 trades fermés.

const DAY = 86400e3;
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

export function dailySeries(points, key = (p) => p.equity) {
  const byDay = new Map();
  for (const p of points) { const t = Date.parse(p.at), v = key(p); if (Number.isFinite(t) && Number.isFinite(v)) byDay.set(Math.floor(t / DAY), v); }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]);
}
export const returnsOf = (series) => series.slice(1).map(([, v], i) => v / series[i][1] - 1);

export function sharpe(r, periods = 365) { const s = std(r); return r.length >= 2 && s > 0 ? (mean(r) / s) * Math.sqrt(periods) : null; }
export function sortino(r, periods = 365) {
  if (r.length < 2) return null;
  const dd = Math.sqrt(r.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / r.length);
  return dd > 0 ? (mean(r) / dd) * Math.sqrt(periods) : null;
}
export function maxDrawdown(values) {
  let peak = -Infinity, mdd = 0;
  for (const v of values) { peak = Math.max(peak, v); if (peak > 0) mdd = Math.max(mdd, 1 - v / peak); }
  return mdd;
}
// Pas d'annualisation sous 7 jours : quelques heures de données donneraient des chiffres absurdes.
export const MIN_DAYS_ANNUAL = 7;
export function annualized(first, last, days) { return first > 0 && last > 0 && days >= MIN_DAYS_ANNUAL ? (last / first) ** (365 / days) - 1 : null; }

// Φ par la fonction d'erreur (Abramowitz et Stegun 7.1.26, erreur < 1,5e-7)
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
export function psr(r, srStar = 0) {
  const n = r.length, s = std(r);
  if (n < 3 || !(s > 0)) return null;
  const m = mean(r), sr = m / s;
  const g3 = r.reduce((a, x) => a + ((x - m) / s) ** 3, 0) / n, g4 = r.reduce((a, x) => a + ((x - m) / s) ** 4, 0) / n;
  const denom = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  return denom > 0 ? normCdf(((sr - srStar) * Math.sqrt(n - 1)) / Math.sqrt(denom)) : null;
}

/* ---------- trades ---------- */

// Trades terminés : fermeture complète (HL ou PM) ou résolution Polymarket. `net` = résultat total, frais et funding compris.
export const closedTrades = (trades) => trades.filter((t) => (t.type === "close" || t.type === "settle") && Number.isFinite(t.net));

export function tradeStats(trades) {
  const c = closedTrades(trades), wins = c.filter((t) => t.net > 0), losses = c.filter((t) => t.net < 0);
  const gw = wins.reduce((s, t) => s + t.net, 0), gl = -losses.reduce((s, t) => s + t.net, 0);
  return { closed: c.length, wins: wins.length, losses: losses.length, winRate: c.length ? wins.length / c.length : null,
    expectancyUsd: c.length ? mean(c.map((t) => t.net)) : null, profitFactor: gl > 0 ? gw / gl : null, grossWin: gw, grossLoss: gl,
    byPocket: Object.fromEntries(["core", "portage", "border"].map((k) => { const x = c.filter((t) => t.pocket === k); return [k, { closed: x.length, netUsd: x.reduce((s, t) => s + t.net, 0) }]; })) };
}

export function brier(trades) {
  const s = trades.filter((t) => t.type === "settle" && Number.isFinite(t.conviction) && typeof t.won === "boolean");
  if (!s.length) return { n: 0, agent: null, market: null, skill: null };
  const o = (t) => (t.won ? 1 : 0), agent = mean(s.map((t) => (t.conviction / 100 - o(t)) ** 2)), market = mean(s.map((t) => (t.entryPx - o(t)) ** 2));
  return { n: s.length, agent, market, skill: market - agent };   // skill > 0 : l'agent prévoit mieux que le prix payé
}

/* ---------- références passives ---------- */

// Achat-conservation de BTC et panier 50/50 BTC-or (sans rééquilibrage), à partir du premier point qui a les deux prix.
export function benchmarks(points, capital) {
  const i0 = points.findIndex((p) => p.bench?.BTC > 0 && p.bench?.GOLD > 0);
  if (i0 < 0) return null;
  const b0 = points[i0].bench, pts = points.slice(i0).filter((p) => p.bench?.BTC > 0 && p.bench?.GOLD > 0);
  const curve = (f) => pts.map((p) => ({ at: p.at, equity: capital * f(p.bench) }));
  const make = (f) => { const c = curve(f), r = returnsOf(dailySeries(c)); return { totalReturn: c.at(-1).equity / capital - 1, sharpe: sharpe(r), maxDrawdown: maxDrawdown(c.map((x) => x.equity)) }; };
  return { since: points[i0].at, btc: make((b) => b.BTC / b0.BTC), btcGold: make((b) => 0.5 * b.BTC / b0.BTC + 0.5 * b.GOLD / b0.GOLD) };
}

/* ---------- synthèse ---------- */

export function summarize({ points = [], trades = [], shadow = null, startCapital = 10_000 } = {}) {
  const eq = points.map((p) => p.equity).filter(Number.isFinite), daily = dailySeries(points), r = returnsOf(daily);
  const first = points[0], last = points.at(-1), days = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / DAY : 0;
  const mdd = maxDrawdown(eq), ann = annualized(startCapital, last?.equity, days), ts = tradeStats(trades);
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? r6(v) : v]));
  return {
    at: last?.at ?? null, since: first?.at ?? null, days: r6(days), points: points.length, dailyReturns: r.length,
    equity: last?.equity ?? startCapital, totalReturn: r6((last?.equity ?? startCapital) / startCapital - 1),
    performance: round({ sharpe: sharpe(r), sortino: sortino(r), calmar: ann != null && mdd > 0 ? ann / mdd : null, maxDrawdown: mdd, annualizedReturn: ann, psr: psr(r) }),
    trades: round(ts), brier: round(brier(trades)),
    significant: ts.closed >= 30,
    benchmarks: benchmarks(points, startCapital),
    models: shadow,
  };
}
