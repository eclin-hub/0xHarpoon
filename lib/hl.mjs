import { fetchJson, num, pool } from "./util.mjs";
import { hlTopic } from "./topics.mjs";

const INFO = "https://api.hyperliquid.xyz/info";
const LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const DEXES = [undefined, "xyz"]; // marché principal + HIP-3 « xyz » (pétrole, or, indices…)

export async function fetchLeaderboard() {
  const raw = await fetchJson(LB, {}, 3);
  return raw.leaderboardRows.map((r) => {
    const w = Object.fromEntries(r.windowPerformances);
    const f = (k) => ({ pnl: num(w[k]?.pnl), roi: num(w[k]?.roi), vlm: num(w[k]?.vlm) });
    return { addr: r.ethAddress, name: r.displayName || null, equity: num(r.accountValue),
             day: f("day"), week: f("week"), month: f("month"), allTime: f("allTime") };
  });
}

export const WINDOWS = ["day", "week", "month", "allTime"];

// Classement live : plus gros PnL en $ par fenêtre
export function topByPnl(rows, n = 50) {
  const out = {};
  for (const w of WINDOWS) {
    out[w] = [...rows].sort((a, b) => b[w].pnl - a[w].pnl).slice(0, n).map((r) => ({
      addr: r.addr, name: r.name, equity: r.equity, pnl: r[w].pnl, roi: r[w].roi, vlm: r[w].vlm,
    }));
  }
  return out;
}

const pct = (arr, key) => {
  const sorted = [...arr].map(key).sort((a, b) => a - b);
  return (x) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
    return lo / Math.max(1, sorted.length - 1);
  };
};

// Échantillon représentatif : comptes gros, actifs, rentables, hors market makers.
export function selectCohort(rows, n = 100, cfg = {}) {
  const { minEquity = 500_000, maxTurnover = 300 } = cfg;
  const pool_ = rows.filter((r) =>
    r.equity >= minEquity && r.week.vlm > 0 && r.month.pnl > 0 && r.allTime.pnl > 0 &&
    r.month.vlm / r.equity < maxTurnover); // exclut les market makers (volume mensuel >> capital)
  const pM = pct(pool_, (r) => r.month.pnl), pA = pct(pool_, (r) => r.allTime.pnl),
        pR = pct(pool_, (r) => r.month.roi), pE = pct(pool_, (r) => r.equity);
  const scored = pool_.map((r) => ({ ...r, score: 0.3 * pM(r.month.pnl) + 0.2 * pA(r.allTime.pnl) + 0.25 * pR(r.month.roi) + 0.25 * pE(r.equity) }));
  scored.sort((a, b) => b.score - a.score);
  return { cohort: scored.slice(0, n), eligible: pool_.length };
}

async function state(addr, dex) {
  const body = { type: "clearinghouseState", user: addr, ...(dex ? { dex } : {}) };
  return fetchJson(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeout: 20000 }, 3);
}

export async function fetchPositions(addr) {
  const positions = [];
  let equity = 0;
  for (const dex of DEXES) {
    const s = await state(addr, dex);
    equity += num(s.marginSummary?.accountValue);
    for (const ap of s.assetPositions || []) {
      const p = ap.position, szi = num(p.szi);
      if (!szi) continue;
      positions.push({
        coin: p.coin, topic: hlTopic(p.coin), side: szi > 0 ? "long" : "short",
        notional: Math.abs(num(p.positionValue)), size: Math.abs(szi), entry: num(p.entryPx),
        upnl: num(p.unrealizedPnl), roe: num(p.returnOnEquity), lev: p.leverage?.value ?? null,
        liq: p.liquidationPx ? num(p.liquidationPx) : null,
      });
    }
  }
  positions.sort((a, b) => b.notional - a.notional);
  const longN = positions.filter((p) => p.side === "long").reduce((s, p) => s + p.notional, 0);
  const shortN = positions.filter((p) => p.side === "short").reduce((s, p) => s + p.notional, 0);
  return { addr, equity, positions, longN, shortN };
}

export async function refreshPositions(cohort, conc = 8) {
  const res = await pool(cohort, conc, (a) => fetchPositions(a.addr));
  return res.map((r, i) => (r && !r.error ? r : { addr: cohort[i].addr, error: true, positions: [], longN: 0, shortN: 0, equity: cohort[i].equity }));
}

// ---- marché : prix, funding, open interest (marché principal + dex xyz) ----
export async function fetchMarkets() {
  const out = {};
  for (const dex of DEXES) {
    const body = { type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) };
    const [meta, ctxs] = await fetchJson(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeout: 20000 }, 3);
    meta.universe.forEach((u, i) => {
      const c = ctxs[i]; if (!c || u.isDelisted) return;
      const mark = num(c.markPx), prev = num(c.prevDayPx);
      out[u.name] = {
        coin: u.name, mark, prev, chg: prev ? mark / prev - 1 : 0,
        funding: num(c.funding),                     // taux par heure
        oi: num(c.openInterest) * mark, vol: num(c.dayNtlVlm), premium: num(c.premium), maxLev: u.maxLeverage,
      };
    });
  }
  return out;
}

// ---- activité : différences entre deux relevés de positions ----
export function diffAccounts(prev, next, minNotional = 250_000) {
  const ev = [], pm = new Map(prev.map((a) => [a.addr, a]));
  for (const a of next) {
    const b = pm.get(a.addr); if (!b || a.error || b.error) continue;
    const key = (p) => p.coin + "|" + p.side, before = new Map(b.positions.map((p) => [key(p), p])), after = new Map(a.positions.map((p) => [key(p), p]));
    for (const [k, p] of after) {
      const o = before.get(k);
      if (!o) { if (p.notional >= minNotional) ev.push({ kind: "open", coin: p.coin, side: p.side, notional: p.notional, delta: p.notional, addr: a.addr, px: p.entry }); }
      else if (o.size && Math.abs(p.size / o.size - 1) >= 0.15 && Math.abs(p.size - o.size) * (p.notional / p.size) >= minNotional) {
        const dn = (p.size - o.size) * (p.notional / p.size);
        ev.push({ kind: dn > 0 ? "add" : "reduce", coin: p.coin, side: p.side, notional: p.notional, delta: dn, addr: a.addr });
      }
    }
    for (const [k, o] of before) if (!after.has(k) && o.notional >= minNotional) ev.push({ kind: "close", coin: o.coin, side: o.side, notional: o.notional, delta: -o.notional, addr: a.addr, upnl: o.upnl });
  }
  return ev;
}

// ---- carte des liquidations de l'échantillon ----
export function liquidationMap(accounts, markets, maxCoins = 10) {
  const byCoin = {};
  for (const a of accounts) for (const p of a.positions) {
    if (!p.liq || !markets[p.coin]) continue;
    const mark = markets[p.coin].mark;
    if (p.liq > mark * 2 || p.liq < mark * 0.3) continue; // liquidation très lointaine : hors carte
    (byCoin[p.coin] ??= []).push({ px: p.liq, n: p.notional, side: p.side });
  }
  return Object.entries(byCoin).map(([coin, list]) => ({ coin, mark: markets[coin].mark, total: list.reduce((s, x) => s + x.n, 0), list }))
    .sort((a, b) => b.total - a.total).slice(0, maxCoins);
}

// ---- bougies quotidiennes : momentum, volatilité, corrélations ----
export const CANDLE_COINS = ["BTC", "ETH", "SOL", "HYPE", "xyz:SP500", "xyz:XYZ100", "xyz:GOLD", "xyz:SILVER", "xyz:CL", "xyz:DXY", "xyz:EUR", "xyz:JPY", "xyz:NVDA", "xyz:TSLA"];
export async function fetchCandles(days = 120) {
  const end = Date.now(), start = end - days * 86400e3;
  const res = await pool(CANDLE_COINS, 4, (coin) => fetchJson(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: start, endTime: end } }), timeout: 25000 }, 3));
  const series = {}; CANDLE_COINS.forEach((c, i) => { if (Array.isArray(res[i]) && res[i].length > 20) series[c] = res[i].map((k) => [k.t, num(k.c)]); });
  const stats = {}, rets = {};
  for (const [c, pts] of Object.entries(series)) {
    const px = pts.map((p) => p[1]), last = px.at(-1), r = (n) => (px.length > n ? last / px.at(-1 - n) - 1 : null), ma = (n) => { const s = px.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; };
    const dr = px.slice(1).map((v, i) => Math.log(v / px[i])), d30 = dr.slice(-30), mu = d30.reduce((a, b) => a + b, 0) / d30.length, vol = Math.sqrt(d30.reduce((a, b) => a + (b - mu) ** 2, 0) / d30.length) * Math.sqrt(365);
    const hi = Math.max(...px.slice(-90));
    stats[c] = { coin: c, last, r1: r(1), r7: r(7), r30: r(30), r90: r(90), ma20: last / ma(20) - 1, ma50: last / ma(50) - 1, vol30: vol, dd: last / hi - 1, spark: px.slice(-60) };
    rets[c] = Object.fromEntries(pts.slice(1).map((p, i) => [p[0], dr[i]]));
  }
  const coins = Object.keys(series), corr = coins.map((a) => coins.map((b) => {
    const ts = Object.keys(rets[a]).filter((t) => t in rets[b]).slice(-30); if (ts.length < 12) return null;
    const x = ts.map((t) => rets[a][t]), y = ts.map((t) => rets[b][t]), mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
    const cov = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0), vx = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0)), vy = Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0));
    return vx && vy ? +(cov / (vx * vy)).toFixed(2) : null;
  }));
  return { at: Date.now(), coins, stats, corr };
}

// ---- agent de paper trading : bougies OHLC, ATR, carnet L2, solde au comptant ----
const post = (body, timeout = 20000) => fetchJson(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeout }, 3);

export const normalizeCandles = (raw) => (Array.isArray(raw) ? raw : [])
  .map((k) => ({ t: num(k.t), o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v) }))
  .filter((k) => k.t && k.h > 0 && k.l > 0 && k.c > 0).sort((a, b) => a.t - b.t);

export async function fetchOhlc(coin, interval = "1d", days = 40) {
  const end = Date.now(), start = end - days * 86400e3;
  return normalizeCandles(await post({ type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: end } }, 25000));
}

// ATR de Wilder : moyenne simple des n premiers vrais écarts, puis lissage (n − 1)/n. null si moins de n + 1 bougies.
export function atr(candles, n = 14) {
  if (!Array.isArray(candles) || candles.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i], pc = candles[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

// Carnet : { bids: [[px, sz]…] du meilleur au pire, asks: idem }
export function normalizeHlBook(raw) {
  const [b = [], a = []] = raw?.levels || [];
  const side = (lv) => lv.map((x) => [num(x.px), num(x.sz)]).filter(([p, s]) => p > 0 && s > 0);
  return { t: num(raw?.time) || Date.now(), bids: side(b).sort((x, y) => y[0] - x[0]), asks: side(a).sort((x, y) => x[0] - y[0]) };
}
export async function fetchL2Book(coin) { return { coin, ...normalizeHlBook(await post({ type: "l2Book", coin })) }; }

// Soldes au comptant (option de la détection de couverture) : { TOKEN: quantité }
export async function fetchSpotBalances(addr) {
  const s = await post({ type: "spotClearinghouseState", user: addr });
  return Object.fromEntries((s?.balances || []).map((b) => [b.coin, num(b.total)]).filter(([, v]) => v));
}
