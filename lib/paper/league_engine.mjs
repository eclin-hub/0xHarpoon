// Entonnoir évolutionnaire à 3 divisions, alimenté par le Flux ∞ (Blueprints X et arXiv, x_alpha.json).
//   D1 L1_SYNTHETIC_LAB : chaque nouveau Blueprint passe le benchmark synthétique (synthetic_market.mjs). Promotion vers D2 :
//      profitFactor ≥ 1,25, maxDrawdown ≤ 12 %, stressSurvivalRate ≥ 80 %, au moins 25 trades simulés ; sinon éliminé.
//      Mutation (Gen-2) : une fois par 24 h, deepseek-flash (puis le reste du socle) fusionne les 2 meilleurs survivants en un Blueprint hybride,
//      qui repasse par D1.
//   D2 L2_LIVE_SHADOW (6 places) : paramètres gelés, 10 000 $ virtuels, trades simulés à chaque cycle sur les vrais prix
//      horaires de 0xHarpoon (frais et glissement compris), hors échantillon. Promotion vers D3 : ≥ 15 trades clos,
//      PSR ≥ 0,75, profitFactor ≥ 1,30, corrélation des rendements < 0,60 avec chaque champion de D3. Relégation (éliminé) :
//      au-delà de 20 trades, PSR < 0,35 ou drawdown > 15 %.
//   D3 D3_MAIN_ENSEMBLE (3 places) : champions dont le signal est mêlé au vote des LLM (router.mjs, metaWeights).
//      Coupe-circuit : drawdown individuel > 8 % depuis l'entrée en D3, ou PSR glissant (20 derniers trades) < 0,50
//      → retour immédiat en D2, sans nouvelle promotion pendant 72 h.
//   Univers élargi (universe.mjs) : une stratégie vise tout Hyperliquid et tout Polymarket (groupes ALL_HL, HL_CRYPTO,
//      HL_TRADFI, ALL_PM ou liste ciblée). En D2/D3, l'univers est résolu à chaque cycle sur le catalogue (e.assets) et les
//      prix horaires de chaque actif retenu sont tenus dans league_market.json (amorçage par les bougies 1 h d'Hyperliquid,
//      cotes de market_history.json pour Polymarket). Les stratégies d'avant l'élargissement reçoivent le groupe de leur
//      classe (migrateUniverses).
//   Statistiques D1 (d1Stats) : figées à l'évaluation au labo, gardées après la promotion en D2 puis D3.
//   Carnet permanent (strategy_ledger.json, updateLedger) : une fiche par stratégie testée, jamais purgée, même quand
//      l'état des ligues ne garde plus que les 60 éliminées les plus récentes.
//   Régime macro (regime_agent.mjs) : chaque stratégie a une famille (inferFamily). En D2/D3, une famille coupée par le
//      régime n'ouvre plus de position (les sorties continuent) ; dans le meta-ensemble, le poids d'un champion D3 est
//      multiplié par familyWeight (0 coupé, 0,5 atténué, 1,25 favorisé) et ses signaux à contre-régime sont écartés.
import { TICKERS, validateBlueprint, coerceBlueprint, blueprintPrompt, inferFamily, FAMILY_V } from "./blueprint.mjs";
import { entryGate, familyWeight, trendDirAt } from "./regime_agent.mjs";
import { resolveUniverse, widenUniverse, UNIVERSE_V, isPmKey, assetLabel, catalogPrompt } from "./universe.mjs";
import { runSyntheticBenchmark } from "./synthetic_market.mjs";
import { newBook, stepBook, bookMetrics, tradeMetrics, scoreAt, returnCorrelation, SIM, enforceCaps } from "./blueprint_eval.mjs";
import { LLMRouter, DEFAULT_PROVIDERS, TASK_PREFER } from "./router.mjs";

const H = 3600e3;
export const LEAGUE = Object.freeze({
  // maxPerDay : nouveaux candidats Gen-1 admis au labo par 24 h glissantes (D1 tourne en simulation locale, sans appel LLM)
  d1: { minPF: 1.25, maxDD: 0.12, minSurvival: 0.8, minTrades: 25, maxPerDay: 8 },
  d2: { slots: 6, capital: 10_000, promote: { minTrades: 15, minPSR: 0.75, minPF: 1.3, maxCorr: 0.6 }, relegate: { afterTrades: 20, minPSR: 0.35, maxDD: 0.15 } },
  d3: { slots: 3, maxDD: 0.08, minPSR: 0.5, rollingTrades: 20, minTradesForPSR: 5, cooldownH: 72 },
  mutationEveryH: 24, outKeep: 60, liveKeep: 720, bootstrapBars: 200,
});
// ticker → actif Hyperliquid
export const COIN = Object.freeze({ BTC: "BTC", ETH: "ETH", SOL: "SOL", HYPE: "HYPE", ZEC: "ZEC", NVDA: "xyz:NVDA", SOXL: "xyz:SOXL", BRENTOIL: "xyz:BRENTOIL" });
export const TICKER_OF = Object.freeze(Object.fromEntries(Object.entries(COIN).map(([t, c]) => [c, t])));

export const emptyLeagues = () => ({ version: 1, updatedAt: null, lastMutationAt: null, entries: [], meta: null, log: [] });
const iso = (t) => new Date(t).toISOString();
const CAPS_V = 2;   // version des plafonds de taille des ligues (mise aux plafonds une fois par carnet)
// statistiques D1 figées (évaluation au labo synthétique), copiées une fois et jamais réécrites
const D1_KEYS = ["trades", "profitFactor", "winRate", "maxDrawdown", "sharpe", "psr", "stressSurvivalRate"];
const d1StatsOf = (d1) => (d1 ? { ...Object.fromEntries(D1_KEYS.map((k) => [k, d1[k] ?? null])), evaluatedAt: d1.at ?? null } : null);
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
  const raw = bench({ ...entry.blueprint, family: entry.family ?? inferFamily(entry.blueprint) });   // la famille règle l'équilibrage stat-arb
  const m = { trades: raw.trades, profitFactor: r3(raw.profitFactor), winRate: r3(raw.winRate), maxDrawdown: r3(raw.maxDrawdown), sharpe: r3(raw.sharpe), psr: r3(raw.psr), stressSurvivalRate: r3(raw.stressSurvivalRate) };
  const v = d1Verdict(m, cfg);
  Object.assign(entry, { d1: { ...m, at: iso(now), progress: d1Progress(m, cfg) }, division: v.pass ? "D1Q" : "OUT", outReason: v.pass ? null : `D1 : ${v.why.join(", ")}`, ...(v.pass ? {} : { outAt: iso(now) }) });
  entry.d1Stats ??= d1StatsOf(entry.d1);
  note(st, now, `${entry.name} (${entry.gen}) ${v.pass ? "qualifié en D1" : "éliminé en D1 : " + v.why.join(", ")}`);
  return entry;
}

// Nouveaux Blueprints de la bibliothèque ∞ → benchmark D1, au plus cfg.d1.maxPerDay candidats Gen-1 par 24 h glissantes
// (les plus intéressants d'abord) ; les autres attendent dans la bibliothèque (st.d1Queue). Les hybrides Gen-2 ne comptent pas.
export function admitBlueprints(state, library = [], { now = Date.now(), bench = runSyntheticBenchmark, cfg = LEAGUE } = {}) {
  const st = structuredClone(state || emptyLeagues()), known = new Set(st.entries.map((e) => e.id));
  const cap = cfg.d1.maxPerDay ?? Infinity;
  let used = st.entries.filter((e) => e.gen === "Gen-1" && now - Date.parse(e.createdAt || 0) < 24 * H && now >= Date.parse(e.createdAt || 0)).length;
  const fresh = library.filter((item) => !known.has(item.id) && validateBlueprint(item.blueprint).ok).sort((a, b) => (b.interest ?? 0) - (a.interest ?? 0));
  let waiting = 0;
  for (const item of fresh) {
    if (used >= cap) { waiting++; continue; }
    used++;
    const s = item.source || {};
    st.entries.push(evaluateD1(st, { id: item.id, name: item.name || item.blueprint.name, gen: "Gen-1", family: item.family || inferFamily(item.blueprint), src: s.src || "x", author: s.author || null,
      url: s.url || null, badge: s.badge || null, excerpt: s.excerpt || null, fingerprint: s.fingerprint || null, testability: item.testability ?? null,
      parents: [], blueprint: item.blueprint, createdAt: iso(now), division: "D1" }, now, bench, cfg));
  }
  st.d1Queue = { at: iso(now), admitted24h: used, cap: Number.isFinite(cap) ? cap : null, waiting };
  return st;
}

/* ---------------- mutation (Gen-2) ---------------- */

const rank = (e) => (e.d2?.metrics?.psr ?? 0) * 2 + (e.d1?.profitFactor ?? 0);
export const mutationPrompt = (catalog = null) => `You breed trading strategies. You receive two parent blueprints that survived a synthetic stress lab and their scores.
Write ONE hybrid blueprint that keeps the strongest blocks and weights of each parent (you may adjust weights, thresholds and exits).
${blueprintPrompt(catalogPrompt(catalog))}`;
export const MUTATION_PROMPT = mutationPrompt(null);

// mutator(parentA, parentB) → Promise<blueprint brut> ; deepseek-flash d'abord (tâche lourde, hors quota de Groq), puis
// deepseek-v4-pro, qwen3.8, gpt-oss-120b, openrouter/free.
export function defaultMutator({ env = process.env, fetch: f = globalThis.fetch, providers = DEFAULT_PROVIDERS, catalog = null } = {}) {
  const system = mutationPrompt(catalog);
  const router = new LLMRouter({ env, providers, fetch: f });
  if (!router.available().length) return null;
  return async (a, b) => {
    const msg = [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ parents: [a, b].map((e) => ({ name: e.name, blueprint: e.blueprint, lab: e.d1, live: e.d2?.metrics ?? null })) }) }];
    const r = await router.collect(1, msg, (json) => { const v = validateBlueprint(coerceBlueprint(json)); return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.errors.slice(0, 3).join(" ; ") }; }, { prefer: [...TASK_PREFER] });
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
// assets : clés d'actifs hors des 8 tickers (symboles Hyperliquid, PM:<cid>|<issue>) utilisées par les stratégies actives ;
// candles[clé] : bougies 1 h d'amorçage ; une série non utilisée depuis 7 jours est effacée.
export function updateLiveMarket(live, { markets = {}, xTickers = {}, history = null, now = Date.now(), candles = {}, assets = [], cfg = LEAGUE } = {}) {
  const L = structuredClone(live || { series: {} });
  L.lastRef = { ...(L.lastRef || {}) };
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
  // actifs élargis : perps Hyperliquid hors des 8 tickers, et cotes Polymarket
  const blank = () => ({ t: [], c: [], h: [], l: [], funding: [], xVel: [], xBias: [], pm: [] });
  const push = (s, t, c, hi = c, lo = c, f = 0) => { s.t.push(t); s.c.push(c); s.h.push(hi); s.l.push(lo); s.funding.push(f); s.xVel.push(1); s.xBias.push(0); s.pm.push(0); };
  const trim = (s) => { for (const k of Object.keys(s)) if (s[k].length > cfg.liveKeep) s[k] = s[k].slice(-cfg.liveKeep); return s; };
  for (const k of new Set(assets)) {
    if (TICKERS.includes(k)) continue;
    L.lastRef[k] = iso(now);
    if (isPmKey(k)) {
      const [, cid, outcome] = k.match(/^PM:(0x[0-9a-fA-F]+)\|(.+)$/) || [];
      const e = history?.pm?.[`${cid}|${outcome}`];
      if (!e?.pts?.length) continue;
      const s = L.series[k] ?? blank();
      for (const [t, p] of e.pts) if (p > 0 && (!s.t.length || t - s.t.at(-1) >= 30 * 60e3)) push(s, t, p);
      L.series[k] = trim(s);
      continue;
    }
    const m = markets[k], boot = candles[k];
    let s = L.series[k];
    if ((!s || s.c.length < cfg.bootstrapBars) && boot?.length) { s = blank(); for (const b of boot) push(s, b.t, b.c, b.h, b.l, m?.funding ?? 0); }
    if (!(m?.mark > 0)) { if (s) L.series[k] = s; continue; }
    s ??= blank();
    if (!s.t.length || now - s.t.at(-1) >= 30 * 60e3) push(s, now, m.mark, m.mark, m.mark, m.funding ?? 0);
    L.series[k] = trim(s);
  }
  for (const k of Object.keys(L.series)) if (!TICKERS.includes(k) && (!L.lastRef[k] || now - Date.parse(L.lastRef[k]) > 7 * 24 * H)) { delete L.series[k]; delete L.lastRef[k]; }
  L.updatedAt = iso(now);
  return L;
}

// Blueprints d'avant l'élargissement (univers limité aux 8 tickers) : on ajoute le groupe de leur classe (HL_CRYPTO,
// HL_TRADFI) pour qu'ils balaient toutes les paires liquides correspondantes. Une fois par stratégie (universeV).
export function migrateUniverses(state, now = Date.now()) {
  const st = structuredClone(state);
  for (const e of st.entries) {
    if ((e.universeV ?? 1) >= UNIVERSE_V) continue;
    e.universeV = UNIVERSE_V;
    if (e.division === "OUT" || !e.blueprint) continue;
    const u = widenUniverse(e.blueprint.universe);
    if (u.length === e.blueprint.universe.length) continue;
    e.originalUniverse = e.blueprint.universe;
    e.blueprint = { ...e.blueprint, universe: u };
    note(st, now, `${e.name} : univers élargi (${e.originalUniverse.join(", ")} → + ${u.slice(e.originalUniverse.length).join(", ")})`);
  }
  return st;
}

// Actifs (hors 8 tickers) à suivre ce cycle : univers résolus des stratégies qualifiées, en D2 et en D3
export function leagueAssets(state, catalog) {
  const out = new Set();
  for (const e of state?.entries || []) if (["D1Q", "D2", "D3"].includes(e.division)) for (const k of resolveUniverse(e.blueprint.universe, catalog)) if (!TICKERS.includes(k)) out.add(k);
  return [...out];
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
// catalog : catalogue du cycle (universe.buildCatalog) pour résoudre les univers ; null : actifs déjà présents dans live.
export function stepLeagues(state, live, { now = Date.now(), cfg = LEAGUE, regime = null, catalog = null } = {}) {
  const st = structuredClone(state);
  for (const e of st.entries) {   // famille (retypée une fois si les règles d'inférence ont changé) et d1Stats
    if (!e.family || (e.familyV ?? 1) < FAMILY_V) { e.family = inferFamily(e.blueprint); e.familyV = FAMILY_V; }
    e.d1Stats ??= d1StatsOf(e.d1);
  }   // stratégies d'avant le typage et d1Stats
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
    // univers résolu du cycle : actifs dont la série de prix existe
    e.assets = (catalog ? resolveUniverse(e.blueprint.universe, catalog) : e.blueprint.universe).filter((k) => live.series?.[k]?.c?.length);
    const gate = regime?.regime ? (T, dir, s, i) => entryGate(regime.regime, e.family, dir, trendDirAt(s, i), side) : null;
    e.regimeWeight = familyWeight(regime?.regime, e.family, side);
    // carnets ouverts sous les anciennes règles (positions de 5 000 à 7 000 $) : mis aux plafonds une fois, au dernier prix
    if ((e.capsV ?? 1) < CAPS_V) {
      const before = Object.keys(b.positions).length, n = t ? enforceCaps(b, { ...e.blueprint, family: e.family }, live.series, lastIdx(live), t, SIM) : 0;
      e.capsV = CAPS_V;
      if (n) note(st, now, `${e.name} : positions mises aux plafonds (15 % par position, 60 % au total, concentration) — ${before} → ${Object.keys(b.positions).length} position(s)`);
    }
    if (t && (!b.lastT || t > b.lastT)) stepBook(b, { ...e.blueprint, universe: e.assets, family: e.family }, live.series, lastIdx(live), t, SIM, gate);
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
      Object.assign(e, { division: "D2", demotedAt: iso(now), demotedReason: why, lastD3: { ...e.d3, until: iso(now) }, d3: null });
      note(st, now, `${e.name} rétrogradé de D3 en D2 (${why})`);
    }
  }
  // relégations D2
  for (const e of inDiv(st, "D2")) {
    const m = e.d2.metrics, r = cfg.d2.relegate;
    if (m.trades > r.afterTrades && ((m.psr ?? 0) < r.minPSR || m.maxDrawdown > r.maxDD)) {
      Object.assign(e, { division: "OUT", outAt: iso(now), outReason: `D2 : ${(m.psr ?? 0) < r.minPSR ? `PSR ${m.psr} < ${r.minPSR}` : `DD ${(m.maxDrawdown * 100).toFixed(1)} % > ${r.maxDD * 100} %`} après ${m.trades} trades` });
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
    for (const T of e.assets?.length ? e.assets : e.blueprint.universe) {
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

/* ---------------- carnet permanent des stratégies (strategy_ledger.json) ---------------- */
// Une fiche par stratégie jamais retirée : identité, famille, génération, source, statut, statistiques D1 (figées), D2 et
// D3 (dernier bilan connu, final après élimination), dates de passage, motif de sortie, Blueprint complet, historique.
// Statuts : D1_PENDING (en attente du labo), D1_QUALIFIED (qualifiée, en attente d'une place en D2), D1_OUT, D2_ACTIVE,
// D2_OUT, D3_CHAMPION, D3_RELEGATED (renvoyée de D3 en D2 par le coupe-circuit, toujours testée en D2).
export const LEDGER_STATUS = Object.freeze(["D1_PENDING", "D1_QUALIFIED", "D1_OUT", "D2_ACTIVE", "D2_OUT", "D3_CHAMPION", "D3_RELEGATED"]);
export const emptyLedger = () => ({ version: 1, updatedAt: null, strategies: [] });
const SOURCE = { x: "X", arxiv: "arXiv", rss: "RSS", mutation: "Mutation", reddit: "Reddit · Quant", github: "GitHub" };

export function ledgerStatus(e) {
  if (e.division === "D3") return "D3_CHAMPION";
  if (e.division === "D2") return e.demotedAt ? "D3_RELEGATED" : "D2_ACTIVE";
  if (e.division === "D1Q") return "D1_QUALIFIED";
  if (e.division === "OUT") return e.d2 ? "D2_OUT" : "D1_OUT";
  return "D1_PENDING";
}

// Fusion non destructive : les fiches absentes de l'état des ligues (purgées) restent telles quelles ; une date de passage
// n'est écrite qu'une fois ; les bilans D2/D3 ne sont remplacés que par un bilan plus récent.
export function updateLedger(ledger, state, now = Date.now()) {
  const L = { ...emptyLedger(), ...(ledger || {}) }, byId = new Map((L.strategies || []).map((x) => [x.id, structuredClone(x)]));
  for (const e of state?.entries || []) {
    const prev = byId.get(e.id), status = ledgerStatus(e);
    const r = prev ?? { id: e.id, history: [], dates: {} };
    Object.assign(r, { name: e.name, family: e.family || inferFamily(e.blueprint), generation: e.gen || "Gen-1", source: e.badge || SOURCE[e.src] || e.src || "X", src: e.src || r.src || "x",
      author: e.author ?? r.author ?? null, url: e.url ?? r.url ?? null, excerpt: e.excerpt ?? r.excerpt ?? null, fingerprint: e.fingerprint ?? r.fingerprint ?? null, parents: e.parents?.length ? e.parents : r.parents ?? [], blueprint: e.blueprint ?? r.blueprint });
    r.d1Stats ??= e.d1Stats ?? d1StatsOf(e.d1);
    const d = (r.dates ??= {});
    d.createdAt ??= e.createdAt ?? iso(now);
    d.evaluatedD1At ??= e.d1?.at ?? null;
    if (e.d2?.since) d.promotedD2At ??= e.d2.since;
    if (e.d3?.since) d.promotedD3At ??= e.d3.since;
    if (e.demotedAt) d.relegatedD3At = e.demotedAt;
    if (e.d2?.metrics) r.d2Stats = { ...e.d2.metrics, since: e.d2.since, asOf: iso(now), final: status === "D2_OUT" };
    const d3 = e.d3 ?? e.lastD3;
    if (d3) r.d3Stats = { since: d3.since, drawdown: d3.drawdown ?? null, rollingPsr: d3.rollingPsr ?? null, maxCorr: d3.maxCorr ?? null, until: e.d3 ? null : d3.until ?? e.demotedAt ?? null, asOf: iso(now) };
    if (status === "D1_OUT" || status === "D2_OUT") { d.closedAt ??= e.outAt ?? (status === "D1_OUT" ? e.d1?.at : null) ?? iso(now); r.exitReason = e.outReason ?? r.exitReason ?? null; }
    else if (status === "D3_RELEGATED") r.exitReason = e.demotedReason ? `D3 → D2 : ${e.demotedReason}` : r.exitReason ?? null;
    if (r.status !== status) {
      r.history = [...(r.history || []), { at: r.status ? iso(now) : status === "D1_OUT" || status === "D1_QUALIFIED" ? e.d1?.at ?? iso(now) : iso(now), status, ...(status.endsWith("_OUT") || status === "D3_RELEGATED" ? { note: r.exitReason } : {}) }];
      r.status = status;
    }
    r.lastSeenAt = iso(now);
    byId.set(e.id, r);
  }
  L.strategies = [...byId.values()].sort((a, b) => Date.parse(b.dates?.createdAt || 0) - Date.parse(a.dates?.createdAt || 0));
  L.updatedAt = iso(now);
  L.counts = Object.fromEntries(LEDGER_STATUS.map((s) => [s, L.strategies.filter((x) => x.status === s).length]));
  return L;
}

/* ---------------- vue publiée des Divisions 2 et 3 (x_alpha.json → leagues) ---------------- */
// Pour chaque stratégie en D2 ou D3 : positions ouvertes (actif, sens, entrée, dernier prix, PnL latent, taille virtuelle)
// et derniers trades clos (actif, sens, entrée, sortie, PnL réalisé, motif), pour comprendre ce qui fait sa performance.
const EXIT_FR = { stop: "stop", objectif: "objectif", "durée": "durée maximale", "signal contraire": "signal contraire", "fin du test": "fin du test", "plafond de taille": "réduite au plafond de 15 %", "plafond de concentration": "fermée (plafond de concentration)", "plafond d'exposition": "réduite au plafond de 60 %" };
export function leagueView(state, live, { catalog = null, history = null, now = Date.now(), recent = 12 } = {}) {
  const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
  const lbl = (k) => assetLabel(k, catalog, history);
  const strategies = (state?.entries || []).filter((e) => (e.division === "D2" || e.division === "D3") && e.d2?.book).map((e) => {
    const b = e.d2.book;
    const open = Object.entries(b.positions || {}).map(([T, p]) => {
      const mark = live?.series?.[T]?.c?.at(-1) ?? p.entry;
      return { asset: T, label: lbl(T), side: p.dir > 0 ? "long" : "short", entry: r4(p.entry), mark: r4(mark), pnlPct: r4(p.dir * (mark / p.entry - 1)),
        notional: Math.round(p.qty * mark * 100) / 100, stop: r4(p.stop), tp: r4(p.tp), since: p.t0 ? iso(p.t0) : null, bars: p.bars };
    });
    const closed = (b.trades || []).slice(-recent).reverse().map((t) => ({ asset: t.T, label: lbl(t.T), side: t.side, entry: r4(t.entry), exit: r4(t.exit),
      pnlPct: r4((t.side === "long" ? 1 : -1) * (t.exit / t.entry - 1)), pnlUsd: Math.round(t.pnl * 100) / 100, reason: EXIT_FR[t.reason] || t.reason,
      opened: t.tOpen ? iso(t.tOpen) : null, closed: t.tClose ? iso(t.tClose) : null, bars: t.bars }));
    return { id: e.id, name: e.name, division: e.division, universe: e.blueprint.universe, assets: e.assets?.length ?? null,
      equity: Math.round(b.equity * 100) / 100, capital: b.capital, trades: b.trades?.length ?? 0, open, closed };
  });
  return { at: iso(now), strategies };
}
