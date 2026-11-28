// Division 1 (L1_SYNTHETIC_LAB) : marchés fictifs calibrés pour éprouver instantanément les Blueprints du Flux ∞.
// Trajectoires horaires multi-actifs (BTC, ETH, SOL, HYPE, ZEC, NVDA, SOXL, BRENTOIL) :
//   1. GJR-GARCH(1,1) : σ²ₜ = ω + (α + γ·1[εₜ₋₁ < 0])·ε²ₜ₋₁ + β·σ²ₜ₋₁ — volatilité en grappes, chocs baissiers amplifiés ;
//   2. sauts de Poisson (jump-diffusion) : krachs éclair, et short squeezes en tendance baissière ;
//   3. régimes cachés (chaîne de Markov) : tendance haussière, tendance baissière, range compressé, crise de volatilité ;
//      chaque scénario contient au moins un épisode de crise (mesure de la survie au stress).
// Séries annexes cohérentes : funding (suit la tendance), vélocité et biais X (suivent les chocs), polymarket_edge
// (mouvement de cote légèrement en avance sur le prix, comme le signal lead-lag réel).
// Tout est déterministe pour une graine donnée : deux Blueprints sont jugés sur les mêmes marchés.
import { TICKERS } from "./blueprint.mjs";
import { syntheticAssets } from "./universe.mjs";
import { newBook, stepBook, closeAll, tradeMetrics } from "./blueprint_eval.mjs";

export function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };
  const poisson = (lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1; };
  return { u, n, poisson };
}

const H_YEAR = 8760;
// volatilité annuelle de base, prix de départ, groupe de facteur commun
export const ASSETS = Object.freeze({
  BTC: { vol: 0.55, p0: 60_000, group: "crypto" }, ETH: { vol: 0.7, p0: 1_700, group: "crypto" }, SOL: { vol: 0.9, p0: 72, group: "crypto" },
  HYPE: { vol: 1.1, p0: 62, group: "crypto" }, ZEC: { vol: 1.0, p0: 750, group: "crypto" }, NVDA: { vol: 0.5, p0: 148, group: "equity" },
  SOXL: { vol: 1.2, p0: 30, group: "equity" }, BRENTOIL: { vol: 0.35, p0: 90, group: "oil" },
  // cote Polymarket synthétique : marche aléatoire en log-cote, ramenée entre 0 et 1 (logistique) ; proxy de tout marché PM
  PMPROXY: { vol: 1.6, p0: 1, group: "pm", pm: true },
});
const RHO = { crypto: 0.7, equity: 0.6, oil: 0.2, pm: 0.05 };
// dérive annuelle, multiplicateur de volatilité, intensité des sauts par heure, taille moyenne / écart des sauts, part de squeezes
export const REGIMES = Object.freeze({
  bull: { mu: 0.8, volMul: 0.85, lam: 0.001, jumpMu: 0.01, jumpSd: 0.008, squeeze: 0 },
  bear: { mu: -0.8, volMul: 1.1, lam: 0.0015, jumpMu: -0.012, jumpSd: 0.01, squeeze: 0.4 },
  range: { mu: 0, volMul: 0.6, lam: 0.0005, jumpMu: 0, jumpSd: 0.006, squeeze: 0 },
  crisis: { mu: -2.5, volMul: 1.9, lam: 0.006, jumpMu: -0.025, jumpSd: 0.015, squeeze: 0.15 },
});
const NAMES = Object.keys(REGIMES), STAY = 0.985;
export const GJR = Object.freeze({ alpha: 0.07, gamma: 0.1, beta: 0.8 });   // persistance 0,92 : la variance suit vite les changements de régime

export function generateScenario(seed, { bars = 500, assets = TICKERS } = {}) {
  const R = rng(seed), regimes = [];
  // régimes : chaîne de Markov, plus un épisode de crise imposé (40 à 80 h, entre 35 % et 70 % du scénario)
  let g = NAMES[Math.floor(R.u() * 3)];
  const cStart = Math.floor(bars * (0.35 + 0.35 * R.u())), cLen = 40 + Math.floor(R.u() * 40);
  for (let i = 0; i < bars; i++) {
    if (i >= cStart && i < cStart + cLen) g = "crisis";
    else if (i === cStart + cLen) g = "bear";
    else if (R.u() > STAY) g = NAMES[Math.floor(R.u() * NAMES.length)];
    regimes.push(g);
  }
  const persist = GJR.alpha + GJR.gamma / 2 + GJR.beta, series = {};
  const common = { crypto: [], equity: [], oil: [], pm: [] };
  for (let i = 0; i < bars; i++) for (const k of Object.keys(common)) common[k].push(R.n());
  for (const T of assets) {
    const A = ASSETS[T], sBar = A.vol / Math.sqrt(H_YEAR), rho = RHO[A.group];
    const s = { t: [], c: [A.p0], h: [A.p0], l: [A.p0], funding: [0.0001], xVel: [1], xBias: [0], pm: [0], ret: [0] };
    let v = sBar * sBar, eps = 0;
    for (let i = 1; i < bars; i++) {
      const rg = REGIMES[regimes[i]], target = (sBar * rg.volMul) ** 2, omega = target * (1 - persist);
      v = omega + (GJR.alpha + (eps < 0 ? GJR.gamma : 0)) * eps * eps + GJR.beta * v;
      const sig = Math.sqrt(v), z = rho * common[A.group][i] + Math.sqrt(1 - rho * rho) * R.n();
      eps = sig * z;
      let jump = 0, nj = R.poisson(rg.lam);
      for (let k = 0; k < nj; k++) jump += (R.u() < rg.squeeze ? Math.abs(rg.jumpMu) * 1.5 : rg.jumpMu) + rg.jumpSd * R.n();
      const r = rg.mu / H_YEAR + eps + jump, o = s.c[i - 1], c = o * Math.exp(r);
      s.c.push(c); s.ret.push(r);
      s.h.push(Math.max(o, c) * Math.exp(Math.abs(R.n()) * sig * 0.6)); s.l.push(Math.min(o, c) * Math.exp(-Math.abs(R.n()) * sig * 0.6));
      const mom = s.ret.slice(-24).reduce((a, b) => a + b, 0);
      s.funding.push(0.8 * s.funding[i - 1] + 0.2 * (0.0001 + 0.003 * Math.tanh(mom / (sig * 5 + 1e-9) / 3)) + 0.00003 * R.n());
      s.xVel.push(Math.max(0.2, 1 + 2.5 * Math.abs(r) / (sBar + 1e-12) * 0.35 + (nj ? 4 : 0) + 0.3 * R.n()));
      s.xBias.push(Math.max(-1, Math.min(1, Math.tanh(mom / (sBar * 5)) + 0.25 * R.n())));
    }
    // cote Polymarket : en avance de quelques heures sur le prix (corrélation faible), bruitée
    for (let i = 1; i < bars; i++) {
      const fwd = s.ret.slice(i + 1, i + 7).reduce((a, b) => a + b, 0);
      s.pm[i] = Math.max(-1, Math.min(1, 0.01 * Math.tanh(fwd / (sBar * Math.sqrt(6))) + 0.07 * R.n()));
    }
    s.t = s.c.map((_, i) => i * 3600e3);
    delete s.ret;
    if (A.pm) {   // cote bornée : p = logistique(1,5 × log-prix) ; pas de funding
      const sig = (x) => 1 / (1 + Math.exp(-1.5 * Math.log(x)));
      s.c = s.c.map(sig); s.h = s.h.map(sig); s.l = s.l.map(sig); s.funding = s.funding.map(() => 0);
    }
    series[T] = s;
  }
  return { seed, bars, regimes, crisis: [cStart, cStart + cLen], series };
}

const median = (a) => { const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
export const BENCH = Object.freeze({ bars: 500, warmup: 60, capital: 10_000, survivalDD: 0.15, survivalEquity: 0.9 });

// Teste un Blueprint sur seedCount scénarios de 500 barres (mêmes graines pour tous les Blueprints).
// → profitFactor, winRate, psr (sur les trades poolés), maxDrawdown (médiane des scénarios), sharpe (moyenne),
//   stressSurvivalRate (part des scénarios — tous traversent une crise — finis avec un drawdown ≤ 15 % et ≥ 90 % du capital).
// L'univers est remplacé par des actifs synthétiques de même classe (universe.syntheticAssets : groupes, actifs
// Hyperliquid hors des 8 tickers, marchés Polymarket → PMPROXY).
export function runSyntheticBenchmark(blueprint, seedCount = 5, { bars = BENCH.bars, seedBase = 1 } = {}) {
  const scenarios = [], trades = [], assets = syntheticAssets(blueprint.universe);
  blueprint = { ...blueprint, universe: assets };
  for (let k = 0; k < seedCount; k++) {
    const sc = generateScenario(seedBase + k * 7919, { bars, assets });
    const book = newBook(BENCH.capital);
    for (let i = BENCH.warmup; i < bars; i++) stepBook(book, blueprint, sc.series, i, i * 3600e3);
    closeAll(book, sc.series, bars - 1, bars * 3600e3);
    const m = tradeMetrics(book.trades, book.returns.map(([, r]) => r));
    scenarios.push({ seed: sc.seed, trades: book.trades.length, maxDrawdown: book.maxDD, totalReturn: book.equity / book.capital - 1, sharpe: m.sharpe,
      survived: book.maxDD <= BENCH.survivalDD && book.equity >= BENCH.survivalEquity * book.capital });
    trades.push(...book.trades);
  }
  const pooled = tradeMetrics(trades), sh = scenarios.map((x) => x.sharpe).filter(Number.isFinite);
  return { trades: trades.length, profitFactor: pooled.profitFactor, winRate: pooled.winRate, psr: pooled.psr,
    maxDrawdown: median(scenarios.map((x) => x.maxDrawdown)), sharpe: sh.length ? sh.reduce((a, b) => a + b, 0) / sh.length : null,
    stressSurvivalRate: scenarios.filter((x) => x.survived).length / scenarios.length, scenarios };
}
