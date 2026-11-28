// Entonnoir évolutionnaire à 3 divisions, alimenté par le Flux ∞ (Blueprints X et arXiv, x_alpha.json).
//   D1 L1_SYNTHETIC_LAB : chaque nouveau Blueprint passe le benchmark synthétique (synthetic_market.mjs). Promotion vers D2 :
//      profitFactor ≥ 1,25, maxDrawdown ≤ 12 %, stressSurvivalRate ≥ 80 %, au moins 25 trades simulés ; sinon éliminé.
//      Mutation (Gen-2) : périodiquement, gemma-4-26b-a4b-it fusionne les 2 meilleurs survivants en un Blueprint hybride,
//      qui repasse par D1.
//   D2 L2_LIVE_SHADOW (6 places) : paramètres gelés, 10 000 $ virtuels, trades simulés à chaque cycle sur les vrais prix
//      horaires de 0xHarpoon (frais et glissement compris), hors échantillon. Promotion vers D3 : ≥ 15 trades clos,
//      PSR ≥ 0,75, profitFactor ≥ 1,30, corrélation des rendements < 0,60 avec chaque champion de D3. Relégation (éliminé) :
//      au-delà de 20 trades, PSR < 0,35 ou drawdown > 15 %.
//   D3 D3_MAIN_ENSEMBLE (3 places) : champions dont le signal est mêlé au vote des LLM (router.mjs, metaWeights).
//      Coupe-circuit : drawdown individuel > 8 % depuis l'entrée en D3, ou PSR glissant (20 derniers trades) < 0,50
//      → retour immédiat en D2, sans nouvelle promotion pendant 72 h.
//   Régime macro (regime_agent.mjs) : chaque stratégie a une famille (inferFamily). En D2/D3, une famille coupée par le
//      régime n'ouvre plus de position (les sorties continuent) ; dans le meta-ensemble, le poids d'un champion D3 est
//      multiplié par familyWeight (0 coupé, 0,5 atténué, 1,25 favorisé) et ses signaux à contre-régime sont écartés.
import { TICKERS, validateBlueprint, coerceBlueprint, BLUEPRINT_PROMPT, inferFamily } from "./blueprint.mjs";
import { entryGate, familyWeight, trendDirAt } from "./regime_agent.mjs";
import { runSyntheticBenchmark } from "./synthetic_market.mjs";
import { newBook, stepBook, bookMetrics, tradeMetrics, scoreAt, returnCorrelation, SIM } from "./blueprint_eval.mjs";
import { LLMRouter, DEFAULT_PROVIDERS } from "./router.mjs";

const H = 3600e3;
export const LEAGUE = Object.freeze({
  d1: { minPF: 1.25, maxDD: 0.12, minSurvival: 0.8, minTrades: 25 },
  d2: { slots: 6, capital: 10_000, promote: { minTrades: 15, minPSR: 0.75, minPF: 1.3, maxCorr: 0.6 }, relegate: { afterTrades: 20, minPSR: 0.35, maxDD: 0.15 } },
  d3: { slots: 3, maxDD: 0.08, minPSR: 0.5, rollingTrades: 20, minTradesForPSR: 5, cooldownH: 72 },
  mutationEveryH: 24, outKeep: 60, liveKeep: 720, bootstrapBars: 200,
});
// ticker → actif Hyperliquid
export const COIN = Object.freeze({ BTC: "BTC", ETH: "ETH", SOL: "SOL", HYPE: "HYPE", ZEC: "ZEC", NVDA: "xyz:NVDA", SOXL: "xyz:SOXL", BRENTOIL: "xyz:BRENTOIL" });
export const TICKER_OF = Object.freeze(Object.fromEntries(Object.entries(COIN).map(([t, c]) => [c, t])));

export const emptyLeagues = () => ({ version: 1, updatedAt: null, lastMutationAt: null, entries: [], meta: null, log: [] });
const iso = (t) => new Date(t).toISOString();
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const note = (st, t, msg) => { st.log.unshift({ at: iso(t), msg }); st.log = st.log.slice(0, 80); };
const inDiv = (st, d) => st.entries.filter((e) => e.division === d);

/* ---------------- Division 1 ---------------- */

export function d1Verdict(m, cfg = LEAGUE) {
  const c = cfg.d1, why = [];
  if (!(m.trades >= c.minTrades)) why.push(`${m.trades} trades < ${c.minTrades}`);
  if (!(m.profitFactor >= c.minPF)) why.push(`PF ${r3(m.profitFactor)} < ${c.minPF}`);
  if (!(m.maxDrawdown <= c.maxDD)) why.push(`DD ${(m.maxDrawdown * 100).toFixed(1)} % > ${c.maxDD * 100} %`);
  if (!(m.stressSurvivalRate >= c.minSurvival)) why.push(`survie au stress ${(m.stressSurvivalRate * 100).toFixed(0)} % < ${c.minSurvival * 100} %`);
  return { pass: !why.length, why };
}
// progression vers la promotion (0 à 1) : le critère le plus en retard
export function d1Progress(m, cfg = LEAGUE) {
  const c = cfg.d1;
  return r3(Math.min(1, (m.trades || 0) / c.minTrades, (m.profitFactor || 0) / c.minPF, m.maxDrawdown > 0 ? c.maxDD / m.maxDrawdown : 1, (m.stressSurvivalRate || 0) / c.minSurvival));
}

function evaluateD1(st, entry, now, bench, cfg) {
  const raw = bench(entry.blueprint);
  const m = { trades: raw.trades, profitFactor: r3(raw.profitFactor), winRate: r3(raw.winRate), maxDrawdown: r3(raw.maxDrawdown), sharpe: r3(raw.sharpe), psr: r3(raw.psr), stressSurvivalRate: r3(raw.stressSurvivalRate) };
  const v = d1Verdict(m, cfg);
  Object.assign(entry, { d1: { ...m, at: iso(now), progress: d1Progress(m, cfg) }, division: v.pass ? "D1Q" : "OUT", outReason: v.pass ? null : `D1 : ${v.why.join(", ")}` });
  note(st, now, `${entry.name} (${entry.gen}) ${v.pass ? "qualifié en D1" : "éliminé en D1 : " + v.why.join(", ")}`);
  return entry;
}

// Nouveaux Blueprints de la bibliothèque ∞ → benchmark D1
export function admitBlueprints(state, library = [], { now = Date.now(), bench = runSyntheticBenchmark, cfg = LEAGUE } = {}) {
  const st = structuredClone(state || emptyLeagues()), known = new Set(st.entries.map((e) => e.id));
  for (const item of library) {
    if (known.has(item.id)) continue;
    const v = validateBlueprint(item.blueprint);
    if (!v.ok) continue;
    st.entries.push(evaluateD1(st, { id: item.id, name: item.name || item.blueprint.name, gen: "Gen-1", family: item.family || inferFamily(item.blueprint), src: item.source?.src || "x", author: item.source?.author || null,
      url: item.source?.url || null, parents: [], blueprint: item.blueprint, createdAt: iso(now), division: "D1" }, now, bench, cfg));
  }
  return st;
}

/* ---------------- mutation (Gen-2) ---------------- */

const rank = (e) => (e.d2?.metrics?.psr ?? 0) * 2 + (e.d1?.profitFactor ?? 0);
export const MUTATION_PROMPT = `You breed trading strategies. You receive two parent blueprints that survived a synthetic stress lab and their scores.
Write ONE hybrid blueprint that keeps the strongest blocks and weights of each parent (you may adjust weights, thresholds and exits).
${BLUEPRINT_PROMPT}`;

// mutator(parentA, parentB) → Promise<blueprint brut> ; par défaut gemma-4-26b-a4b-it (clé Gemini), gemma-4-31b en secours.
export function defaultMutator({ env = process.env, fetch: f = globalThis.fetch } = {}) {
  const providers = DEFAULT_PROVIDERS.filter((p) => p.name === "gemma" || p.name === "openrouter").map((p) => ({ ...p, models: p.models.filter((m) => m.role === "arbiter") })).filter((p) => p.models.length);
  const router = new LLMRouter({ env, providers, fetch: f });
  if (!router.available().length) return null;
  return async (a, b) => {
    const msg = [{ role: "system", content: MUTATION_PROMPT }, { role: "user", content: JSON.stringify({ parents: [a, b].map((e) => ({ name: e.name, blueprint: e.blueprint, lab: e.d1, live: e.d2?.metrics ?? null })) }) }];
    const r = await router.collect(1, msg, (json) => { const v = validateBlueprint(coerceBlueprint(json)); return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.errors.slice(0, 3).join(" ; ") }; }, { role: "arbiter" });
    if (!r.results.length) throw new Error(r.errors.at(-1) || "aucun modèle");
    return { blueprint: r.results[0].value, model: r.results[0].model };
  };
}

export async function maybeMutate(state, { now = Date.now(), mutator = null, bench = runSyntheticBenchmark, cfg = LEAGUE, force = false } = {}) {
  const st = structuredClone(state);
  if (!mutator) return st;
  if (!force && st.lastMutationAt && now - Date.parse(st.lastMutationAt) < cfg.mutationEveryH * H) return st;
  const parents = st.entries.filter((e) => ["D1Q", "D2", "D3"].includes(e.division)).sort((a, b) => rank(b) - rank(a)).slice(0, 2);
  if (parents.length < 2) return st;
  st.lastMutationAt = iso(now);
  try {
    const out = await mutator(parents[0], parents[1]);
    const v = validateBlueprint(coerceBlueprint(out.blueprint ?? out));
    if (!v.ok) { note(st, now, `mutation rejetée : ${v.errors.slice(0, 2).join(", ")}`); return st; }
    const id = `gen2-${parents[0].id.slice(-6)}-${parents[1].id.slice(-6)}-${Math.floor(now / 1000).toString(36)}`;
    st.entries.push(evaluateD1(st, { id, name: v.value.name || `Hybride ${parents[0].name} × ${parents[1].name}`, gen: "Gen-2", family: inferFamily(v.value), src: "mutation", author: out.model || "gemma-4-26b-a4b-it",
      parents: parents.map((p) => p.id), parentSrc: [...new Set(parents.map((p) => p.src))], blueprint: v.value, createdAt: iso(now), division: "D1" }, now, bench, cfg));
  } catch (e) { note(st, now, `mutation impossible : ${String(e.message || e).slice(0, 120)}`); }
  return st;
}

/* ---------------- données live (Divisions 2 et 3) ---------------- */

// Prix horaires réels par ticker, gardés 30 jours : clôture = prix mark du cycle ; amorçage par les bougies 1 h d'Hyperliquid.
// live : { series: { TICKER: { t, c, h, l, funding, xVel, xBias, pm } } }
export function updateLiveMarket(live, { markets = {}, xTickers = {}, history = null, now = Date.now(), candles = {}, cfg = LEAGUE } = {}) {
  const L = structuredClone(live || { series: {} });
  for (const T of TICKERS) {
    const coin = COIN[T], m = markets[coin];
    let s = L.series[T];
    const boot = candles[T];
    if ((!s || s.c.length < cfg.bootstrapBars) && boot?.length) {
      s = { t: [], c: [], h: [], l: [], funding: [], xVel: [], xBias: [], pm: [] };
      for (const k of boot) { s.t.push(k.t); s.c.push(k.c); s.h.push(k.h); s.l.push(k.l); s.funding.push(m?.funding ?? 0); s.xVel.push(1); s.xBias.push(0); s.pm.push(0); }
    }
    if (!(m?.mark > 0)) { if (s) L.series[T] = s; continue; }
    s ??= { t: [], c: [], h: [], l: [], funding: [], xVel: [], xBias: [], pm: [] };
    if (s.t.length && now - s.t.at(-1) < 30 * 60e3) { L.series[T] = s; continue; }   // une barre par heure au plus
    const x = xTickers[T]?.active ? xTickers[T] : null;
    let pm = 0;   // plus fort mouvement de cote Polymarket (2 h), orienté dans le sens du sous-jacent
    for (const e of Object.values(history?.pm || {})) {
      if (e.coin !== coin) continue;
      const win = e.pts.filter(([t]) => t >= now - 2 * H);
      if (win.length >= 2) { const d = (win.at(-1)[1] - win[0][1]) * (e.view || 0); if (Math.abs(d) > Math.abs(pm)) pm = d; }
    }
    s.t.push(now); s.c.push(m.mark); s.h.push(m.mark); s.l.push(m.mark); s.funding.push(m.funding ?? 0);
    s.xVel.push(x?.mentionVelocityRatio ?? 1); s.xBias.push(x?.netNarrativeBias ?? 0); s.pm.push(Math.round(pm * 1e4) / 1e4);
    for (const k of Object.keys(s)) if (s[k].length > cfg.liveKeep) s[k] = s[k].slice(-cfg.liveKeep);
    L.series[T] = s;
  }
  L.updatedAt = iso(now);
  return L;
}
const lastIdx = (live) => (T) => (live.series[T]?.c.length ? live.series[T].c.length - 1 : null);
const lastT = (live) => Math.max(0, ...Object.values(live.series).map((s) => s.t.at(-1) || 0));

/* ---------------- Divisions 2 et 3 ---------------- */

function rollingPsr(e, cfg) {
  const tr = e.d2.book.trades.slice(-cfg.d3.rollingTrades);
  return tr.length >= cfg.d3.minTradesForPSR ? tradeMetrics(tr).psr : null;
}

// Un cycle live : remplit D2, fait trader D2 et D3 sur la dernière barre, applique promotions, relégations et coupe-circuit.
// regime : régime macro du cycle (evaluateMacroRegime) ou null ; il filtre les ouvertures par famille.
export function stepLeagues(state, live, { now = Date.now(), cfg = LEAGUE, regime = null } = {}) {
  const st = structuredClone(state);
  for (const e of st.entries) e.family ??= inferFamily(e.blueprint);   // Blueprints compilés avant le typage
  st.regime = regime?.regime ? { regime: regime.regime, at: regime.at ?? iso(now) } : null;
  // places libres en D2 : les qualifiés de D1, meilleur PF d'abord
  const queue = inDiv(st, "D1Q").sort((a, b) => (b.d1.profitFactor ?? 0) - (a.d1.profitFactor ?? 0));
  for (const e of queue) {
    if (inDiv(st, "D2").length >= cfg.d2.slots) break;
    Object.assign(e, { division: "D2", d2: { since: iso(now), book: newBook(cfg.d2.capital), metrics: null } });
    note(st, now, `${e.name} entre en D2 (paramètres gelés, ${cfg.d2.capital} $ virtuels)`);
  }
  const t = lastT(live);
  for (const e of st.entries.filter((x) => x.division === "D2" || x.division === "D3")) {
    const b = e.d2.book, side = e.blueprint.side;
    const gate = regime?.regime ? (T, dir, s, i) => entryGate(regime.regime, e.family, dir, trendDirAt(s, i), side) : null;
    e.regimeWeight = familyWeight(regime?.regime, e.family, side);
    if (t && (!b.lastT || t > b.lastT)) stepBook(b, e.blueprint, live.series, lastIdx(live), t, SIM, gate);
    const m = bookMetrics(b);
    e.d2.metrics = { trades: m.trades, winRate: r3(m.winRate), profitFactor: r3(m.profitFactor), psr: r3(m.psr), sharpe: r3(m.sharpe), maxDrawdown: r3(m.maxDrawdown), equity: r3(m.equity), totalReturn: r3(m.totalReturn),
      progress: r3(Math.min(1, m.trades / cfg.d2.promote.minTrades, (m.psr ?? 0) / cfg.d2.promote.minPSR, (m.profitFactor ?? 0) / cfg.d2.promote.minPF)) };
    if (e.division === "D3") { e.d3.peak = Math.max(e.d3.peak, b.equity); e.d3.drawdown = r3(1 - b.equity / e.d3.peak); e.d3.rollingPsr = r3(rollingPsr(e, cfg)); }
  }
  // coupe-circuit D3
  for (const e of inDiv(st, "D3")) {
    const dd = e.d3.drawdown ?? 0, rp = e.d3.rollingPsr;
    if (dd > cfg.d3.maxDD || (rp != null && rp < cfg.d3.minPSR)) {
      const why = dd > cfg.d3.maxDD ? `drawdown ${(dd * 100).toFixed(1)} % > ${cfg.d3.maxDD * 100} %` : `PSR glissant ${rp} < ${cfg.d3.minPSR}`;
      Object.assign(e, { division: "D2", demotedAt: iso(now), d3: null });
      note(st, now, `${e.name} rétrogradé de D3 en D2 (${why})`);
    }
  }
  // relégations D2
  for (const e of inDiv(st, "D2")) {
    const m = e.d2.metrics, r = cfg.d2.relegate;
    if (m.trades > r.afterTrades && ((m.psr ?? 0) < r.minPSR || m.maxDrawdown > r.maxDD)) {
      Object.assign(e, { division: "OUT", outReason: `D2 : ${(m.psr ?? 0) < r.minPSR ? `PSR ${m.psr} < ${r.minPSR}` : `DD ${(m.maxDrawdown * 100).toFixed(1)} % > ${r.maxDD * 100} %`} après ${m.trades} trades` });
      note(st, now, `${e.name} éliminé de D2 (${e.outReason.slice(5)})`);
    }
  }
  // promotions D2 → D3
  const p = cfg.d2.promote;
  for (const e of inDiv(st, "D2").sort((a, b) => (b.d2.metrics.psr ?? 0) - (a.d2.metrics.psr ?? 0))) {
    if (inDiv(st, "D3").length >= cfg.d3.slots) break;
    const m = e.d2.metrics;
    if (m.trades < p.minTrades || (m.psr ?? 0) < p.minPSR || (m.profitFactor ?? 0) < p.minPF) continue;
    if (e.demotedAt && now - Date.parse(e.demotedAt) < cfg.d3.cooldownH * H) continue;
    const corr = inDiv(st, "D3").map((c) => returnCorrelation(e.d2.book.returns, c.d2.book.returns)).filter((x) => x != null);
    if (corr.some((c) => c >= p.maxCorr)) continue;
    Object.assign(e, { division: "D3", d3: { since: iso(now), peak: e.d2.book.equity, drawdown: 0, rollingPsr: r3(rollingPsr(e, cfg)), maxCorr: corr.length ? r3(Math.max(...corr)) : null } });
    note(st, now, `${e.name} promu en D3 (PSR ${m.psr}, PF ${m.profitFactor}, ${m.trades} trades)`);
  }
  // éliminés : on garde les plus récents, sans carnet
  const out = st.entries.filter((e) => e.division === "OUT");
  for (const e of out) if (e.d2) e.d2 = { since: e.d2.since, metrics: e.d2.metrics, curve: e.d2.book?.curve?.slice(-200) ?? e.d2.curve ?? [] };
  const drop = new Set(out.slice(0, Math.max(0, out.length - cfg.outKeep)).map((e) => e.id));
  st.entries = st.entries.filter((e) => !drop.has(e.id));
  st.updatedAt = iso(now);
  return st;
}

// Signal courant des champions de D3 : { id, family, regimeMult, psr, signals: { TICKER: score −1..1 }, gated }
// regime : un signal que le régime interdit (contre-tendance, achat en krach…) est écarté (gated), pas mis à 0 : un 0
// tirerait la conviction du meta-ensemble vers 50.
export function championSignals(state, live, regime = null) {
  const R = regime?.regime ?? regime ?? null;
  return inDiv(state, "D3").map((e) => {
    const signals = {}, gated = [], family = e.family || inferFamily(e.blueprint), side = e.blueprint.side;
    for (const T of e.blueprint.universe) {
      const s = live.series[T]; if (!s?.c.length) continue;
      const i = s.c.length - 1, sc = scoreAt(e.blueprint, s, i);
      if (sc == null) continue;
      if (R && sc !== 0 && !(entryGate(R, family, Math.sign(sc), trendDirAt(s, i), side) > 0)) { gated.push(T); continue; }
      signals[T] = r3(sc);
    }
    return { id: e.id, name: e.name, family, regimeMult: familyWeight(R, family, side), psr: e.d2.metrics?.psr ?? e.d3?.rollingPsr ?? 0, signals, gated };
  });
}

// Statut affiché dans la bibliothèque ∞ (x_alpha.json)
export function libraryStatus(state) {
  const out = {};
  for (const e of state.entries) out[e.id] = e.division === "D3" ? "Promu" : e.division === "D2" || e.division === "D1Q" ? "En test" : e.division === "OUT" ? (e.d2 ? "Éliminé D2" : "Éliminé D1") : "En attente D1";
  return out;
}
