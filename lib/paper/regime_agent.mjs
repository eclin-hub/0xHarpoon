// Méta-Agent de Régime Macro : qualifie le régime de marché à chaque cycle et décide quelles familles de stratégies
// (blueprint.mjs, inferFamily) sont autorisées, favorisées ou coupées dans les Divisions 2 et 3 et le meta-ensemble.
// Les équations des ligues restent les capteurs d'exécution ; cet agent est le chef d'orchestre au-dessus.
//
// Entrées, croisées à chaque cycle :
//   1. Calendrier économique live (lib/alt.mjs, fetchCalendar : ForexFactory, semaine en cours, gardé 60 min) :
//      événements critiques (FOMC, taux Fed / BCE, CPI, NFP, PCE…) dans la fenêtre de −4 h à +2 h autour de la publication.
//   2. Métriques de marché sur BTC, ETH, NVDA et BRENTOIL (prix horaires réels des ligues, league_market.json) :
//      volatilité réalisée 24 h contre 7 jours (expansion ATR), rendements 4 h / 24 h / 72 h, force de tendance ;
//      funding Hyperliquid (taux horaire) ; vélocité et biais du Flux ε (x_alpha.json), alertes de squeeze.
//   3. Synthèse LLM (meilleur votant actif du classement, llm_ranking.mjs), en cache 2 h ; cache invalidé dès qu'un
//      événement critique entre dans la fenêtre. Le LLM confirme ou nuance ; il ne peut jamais lever un stress dur
//      (événement du calendrier, krach, choc de volatilité) : ces règles-là sont déterministes.
//
// 5 régimes :
//   RISK_OFF_CRASH      rupture baissière rapide (BTC −6 % en 24 h ou −3,5 % en 4 h, ETH −8 % en 24 h)
//   MACRO_EVENT_STRESS  événement critique à moins de 4 h (ou publié depuis moins de 2 h), ou choc de volatilité
//                       (volatilité 24 h ≥ 2,2 × celle des 7 jours sur BTC ou ETH)
//   SQUEEZE_CROWDED     funding extrême (≥ 0,01 %/h ≈ 88 %/an sur BTC ou ETH) + vélocité haussière sur X ou hausse ≥ 4 %
//   TREND_RISK_ON       tendance nette (|force| ≥ 1,5 sur 72 h) et volatilité maîtrisée (≤ 1,6 × la normale)
//   RANGE_COMPRESSION   volatilité comprimée (≤ 0,85 × la normale) et pas de tendance ; régime par défaut sans tendance
//
// Politique par famille (familyWeight : poids dans le meta-ensemble ; entryGate : ouverture d'une position en D2/D3) :
//   MACRO_EVENT_STRESS  seules stat_arb_leadlag et defensive_hedge restent actives (les autres : poids 0)
//   RANGE_COMPRESSION   mean_reversion et stat_arb_leadlag × 1,25 ; trend_breakout × 0,5
//   TREND_RISK_ON et    trend_breakout et volatility_squeeze × 1,25 ; mean_reversion coupée contre la tendance
//   SQUEEZE_CROWDED     (aucune entrée à contre-sens de la tendance 72 h du ticker)
//   RISK_OFF_CRASH      trend_breakout coupée à l'achat (Blueprints « long » : poids 0) ; defensive_hedge et
//                       volatility_squeeze × 1,25
// Risque (risk.mjs) : en MACRO_EVENT_STRESS et RISK_OFF_CRASH, taille des nouvelles positions × 0,5 et conviction
// minimale relevée de 60 à 70.

export const REGIMES = Object.freeze(["TREND_RISK_ON", "SQUEEZE_CROWDED", "MACRO_EVENT_STRESS", "RANGE_COMPRESSION", "RISK_OFF_CRASH"]);
export const STRESS = Object.freeze(["MACRO_EVENT_STRESS", "RISK_OFF_CRASH"]);
export const REGIME_LABEL = Object.freeze({ TREND_RISK_ON: "Tendance, appétit pour le risque", SQUEEZE_CROWDED: "Positionnement encombré, risque de squeeze",
  MACRO_EVENT_STRESS: "Stress d'événement macro", RANGE_COMPRESSION: "Range, volatilité comprimée", RISK_OFF_CRASH: "Aversion au risque, krach" });

export const REGIME_CFG = Object.freeze({
  windowBeforeH: 4, windowAfterH: 2, llmCacheH: 2, calendarRefreshMin: 60, lookaheadH: 48,
  tickers: ["BTC", "ETH", "NVDA", "BRENTOIL"], coin: { BTC: "BTC", ETH: "ETH", NVDA: "xyz:NVDA", BRENTOIL: "xyz:BRENTOIL" },
  crash: { btc24: -0.06, btc4: -0.035, eth24: -0.08 },
  volShock: 2.2, trendMin: 1.5, trendVolMax: 1.6, compression: 0.85, extremeFunding: 0.0001, squeezeRise: 0.04,
  squeezeVelocity: 2.2, squeezeBias: 0.35, llmOverrideConfidence: 70,
  stressRisk: { sizeMult: 0.5, minConviction: 70 },
});

// Événements critiques : décisions de taux et publications qui déplacent tout le marché
export const CRITICAL = /\b(FOMC|Federal Funds Rate|Fed (Chair|Interest Rate)|Powell|CPI|Consumer Price Index|Non-Farm|NFP|PCE|Main Refinancing Rate|ECB (Press|Monetary|Interest)|Monetary Policy (Statement|Decision)|Interest Rate Decision)\b/i;
export const CRITICAL_CUR = Object.freeze(["USD", "EUR"]);
const H = 3600e3;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const sd = (a) => { if (a.length < 2) return null; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const iso = (t) => new Date(t).toISOString();

export const emptyRegimeCache = () => ({ version: 1, calendar: null, llm: null, last: null });

/* ---------------- 1. calendrier ---------------- */

export const isCritical = (e) => e && e.impact === "High" && CRITICAL_CUR.includes(e.cur) && CRITICAL.test(e.title || "");

// events : [{ title, cur, t, impact }] → { inWindow, next, upcoming, key }
export function calendarWindow(events = [], now = Date.now(), cfg = REGIME_CFG) {
  const evs = (events || []).filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const crit = evs.filter(isCritical);
  const inWindow = crit.filter((e) => e.t - now <= cfg.windowBeforeH * H && now - e.t <= cfg.windowAfterH * H);
  const next = crit.find((e) => e.t > now) ?? null;
  const upcoming = evs.filter((e) => e.impact === "High" && e.t > now - cfg.windowAfterH * H && e.t <= now + cfg.lookaheadH * H).slice(0, 12);
  const view = (e) => (e ? { title: e.title, cur: e.cur, t: iso(e.t), impact: e.impact, critical: isCritical(e), inMin: Math.round((e.t - now) / 60e3) } : null);
  return { inWindow: inWindow.map(view), next: view(next), upcoming: upcoming.map(view), key: inWindow.map((e) => `${e.cur}|${e.title}|${e.t}`).join(";") };
}

/* ---------------- 2. métriques de marché ---------------- */

// live : league_market.json ({ series: { TICKER: { t, c, funding } } }) ; markets : marchés Hyperliquid du cycle (funding horaire)
export function marketMetrics(live = null, markets = {}, cfg = REGIME_CFG) {
  const out = {};
  for (const T of cfg.tickers) {
    const s = live?.series?.[T], c = s?.c || [];
    const funding = markets?.[cfg.coin[T]]?.funding ?? s?.funding?.at(-1) ?? null;
    if (c.length < 30) { out[T] = { bars: c.length, funding: r4(funding) }; continue; }
    const rets = c.slice(1).map((x, i) => Math.log(x / c[i])), n = rets.length;
    const rv24 = sd(rets.slice(-24)), base = sd(rets.slice(Math.max(0, n - 168), Math.max(2, n - 24))) || sd(rets);
    const ret = (k) => (c.length > k ? c.at(-1) / c.at(-1 - k) - 1 : null);
    const k72 = Math.min(72, c.length - 1);
    out[T] = { bars: c.length, ret4: r4(ret(4)), ret24: r4(ret(24)), ret72: r4(ret(k72)), rv24: r4(rv24), rvBase: r4(base),
      volRatio: r4(base > 0 ? rv24 / base : null), trend: r4(base > 0 ? Math.log(c.at(-1) / c.at(-1 - k72)) / (base * Math.sqrt(k72)) : null), funding: r4(funding) };
  }
  return out;
}

// Signal du Flux ε (epsilonSummary de x_scraper) sur BTC et ETH : squeeze, vélocité et biais haussiers
export function epsilonSignal(epsilon = {}, cfg = REGIME_CFG) {
  const xs = ["BTC", "ETH"].map((t) => epsilon?.[t]).filter((e) => e?.active);
  return { squeeze: xs.some((e) => e.squeezeWarning), hot: xs.some((e) => (e.mentionVelocityRatio ?? 0) >= cfg.squeezeVelocity && (e.netNarrativeBias ?? 0) > cfg.squeezeBias),
    velocity: r4(Math.max(0, ...xs.map((e) => e.mentionVelocityRatio ?? 0))), bias: r4(xs.length ? xs.reduce((a, e) => a + (e.netNarrativeBias ?? 0), 0) / xs.length : 0) };
}

/* ---------------- classement déterministe ---------------- */

// → { regime, hard, confidence, reasons }
export function classifyRegime({ calendar, metrics, eps }, cfg = REGIME_CFG) {
  const B = metrics.BTC || {}, E = metrics.ETH || {}, why = [];
  const pc = (x) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;
  // krach : rupture baissière rapide
  if ((B.ret24 ?? 0) <= cfg.crash.btc24 || (B.ret4 ?? 0) <= cfg.crash.btc4 || (E.ret24 ?? 0) <= cfg.crash.eth24) {
    if ((B.ret24 ?? 0) <= cfg.crash.btc24) why.push(`BTC ${pc(B.ret24)} en 24 h`);
    if ((B.ret4 ?? 0) <= cfg.crash.btc4) why.push(`BTC ${pc(B.ret4)} en 4 h`);
    if ((E.ret24 ?? 0) <= cfg.crash.eth24) why.push(`ETH ${pc(E.ret24)} en 24 h`);
    return { regime: "RISK_OFF_CRASH", hard: true, confidence: 90, reasons: why };
  }
  if (calendar.inWindow.length) {
    const e = calendar.inWindow[0];
    return { regime: "MACRO_EVENT_STRESS", hard: true, confidence: 95, reasons: [`${e.cur} ${e.title} ${e.inMin >= 0 ? `dans ${e.inMin} min` : `publié il y a ${-e.inMin} min`}`, ...calendar.inWindow.slice(1).map((x) => `${x.cur} ${x.title}`)] };
  }
  const shock = ["BTC", "ETH"].filter((t) => (metrics[t]?.volRatio ?? 0) >= cfg.volShock);
  if (shock.length) return { regime: "MACRO_EVENT_STRESS", hard: true, confidence: 80, reasons: shock.map((t) => `choc de volatilité ${t} : ${metrics[t].volRatio.toFixed(2)} × la normale`) };
  const fund = Math.max(B.funding ?? 0, E.funding ?? 0);
  if (fund >= cfg.extremeFunding && (eps.squeeze || eps.hot || (B.ret24 ?? 0) >= cfg.squeezeRise)) {
    why.push(`funding ${(fund * 100).toFixed(4)} %/h (≈ ${Math.round(fund * 8760 * 100)} %/an)`);
    if (eps.squeeze || eps.hot) why.push(`Flux ε : vélocité ${eps.velocity}×, biais ${eps.bias}`);
    if ((B.ret24 ?? 0) >= cfg.squeezeRise) why.push(`BTC ${pc(B.ret24)} en 24 h`);
    return { regime: "SQUEEZE_CROWDED", hard: false, confidence: 75, reasons: why };
  }
  const tr = [B.trend, E.trend].filter(Number.isFinite), trend = tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
  const vr = Math.max(...["BTC", "ETH"].map((t) => metrics[t]?.volRatio).filter(Number.isFinite), -Infinity);
  if (trend == null || !Number.isFinite(vr)) return { regime: "RANGE_COMPRESSION", hard: false, confidence: 30, reasons: ["historique de prix insuffisant : régime neutre par défaut"] };
  if (Math.abs(trend) >= cfg.trendMin && vr <= cfg.trendVolMax) return { regime: "TREND_RISK_ON", hard: false, confidence: 70, reasons: [`force de tendance ${trend.toFixed(2)} (${trend > 0 ? "haussière" : "baissière"})`, `volatilité ${vr.toFixed(2)} × la normale`] };
  if (vr <= cfg.compression && Math.abs(trend) < 1) return { regime: "RANGE_COMPRESSION", hard: false, confidence: 70, reasons: [`volatilité comprimée ${vr.toFixed(2)} × la normale`, `force de tendance ${trend.toFixed(2)}`] };
  return Math.abs(trend) >= 1
    ? { regime: "TREND_RISK_ON", hard: false, confidence: 50, reasons: [`tendance modérée ${trend.toFixed(2)}`, `volatilité ${vr.toFixed(2)} × la normale`] }
    : { regime: "RANGE_COMPRESSION", hard: false, confidence: 50, reasons: [`pas de tendance nette (${trend.toFixed(2)})`, `volatilité ${vr.toFixed(2)} × la normale`] };
}

/* ---------------- 3. synthèse LLM ---------------- */

export const REGIME_PROMPT = `You are a macro strategist. Classify the current crypto / risk-asset market regime into exactly one of:
TREND_RISK_ON (healthy directional trend, contained volatility), SQUEEZE_CROWDED (extreme funding and euphoric social velocity: squeeze risk),
MACRO_EVENT_STRESS (major scheduled macro release within 4 hours, or an active volatility shock), RANGE_COMPRESSION (low volatility, no trend),
RISK_OFF_CRASH (fast bearish break, systemic stress).
You receive a deterministic pre-classification, market metrics (returns, realized volatility vs its 7-day norm, trend strength, hourly funding),
the high-impact economic calendar and recent social headlines. Confirm or nuance it. Answer with JSON only:
{"regime":"<one of the five>","confidence":0-100,"rationale":"<one or two sentences in French>"}`;

export function validateRegimeAnswer(j) {
  if (!j || !REGIMES.includes(j.regime)) return { ok: false, error: `regime : ${REGIMES.join(", ")}` };
  const c = Number(j.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 100) return { ok: false, error: "confidence : 0 à 100" };
  return { ok: true, value: { regime: j.regime, confidence: Math.round(c), rationale: String(j.rationale ?? "").slice(0, 400) } };
}

const headlines = (epsilon = {}) => Object.entries(epsilon || {}).flatMap(([t, e]) => (e.active ? (e.catalysts || []).map((c) => ({ t, text: c.text.slice(0, 160), bias: c.bias })) : [])).slice(0, 8);

// cache : { at, key, regime, confidence, rationale, model } ; valable 2 h, et tant que la fenêtre du calendrier n'a pas changé
export const llmCacheValid = (cache, key, now = Date.now(), cfg = REGIME_CFG) => !!cache && cache.key === key && now - Date.parse(cache.at) < cfg.llmCacheH * H && now >= Date.parse(cache.at);

async function llmSynthesis({ router, ranking, quant, metrics, calendar, epsilon, now, cache, cfg }) {
  if (llmCacheValid(cache, calendar.key, now, cfg)) return { ...cache, cached: true };
  if (!router?.collect) return cache && Date.parse(cache.at) <= now ? { ...cache, stale: true } : null;
  const prefer = ranking?.active?.length ? [...ranking.active, ...(ranking.order || [])] : null;
  const messages = [{ role: "system", content: REGIME_PROMPT }, { role: "user", content: JSON.stringify({ now: iso(now), pre_classification: { regime: quant.regime, reasons: quant.reasons },
    metrics, calendar_high_impact: calendar.upcoming, headlines: headlines(epsilon) }) }];
  try {
    const r = await router.collect(1, messages, validateRegimeAnswer, { role: "voter", prefer });
    const a = r.results[0];
    if (!a) return { error: r.errors.join(" | ").slice(0, 300) || "aucun modèle", at: iso(now), key: calendar.key };
    return { at: iso(now), key: calendar.key, model: a.model, ...a.value };
  } catch (e) { return { error: String(e.message || e).slice(0, 300), at: iso(now), key: calendar.key }; }
}

/* ---------------- évaluation complète ---------------- */

// → { regime, source, confidence, reasons, llm, calendar: { next, inWindow, upcoming }, metrics, eps, policy, risk } et cache mis à jour
export async function evaluateMacroRegime({ calendarEvents = null, fetchCalendar = null, live = null, markets = {}, epsilon = {}, router = null, ranking = null,
  cache = null, now = Date.now(), cfg = REGIME_CFG } = {}) {
  const c = { ...emptyRegimeCache(), ...(cache || {}) }, notes = [];
  // calendrier : fourni, sinon relu au plus toutes les 60 min (ForexFactory limite les appels)
  let events = calendarEvents;
  if (!events) {
    const fresh = c.calendar && now - c.calendar.at < cfg.calendarRefreshMin * 60e3 && now >= c.calendar.at;
    if (!fresh && fetchCalendar) {
      try { const cal = await fetchCalendar(); c.calendar = { at: now, events: cal.events }; }
      catch (e) { notes.push(`calendrier indisponible (${String(e.message || e).slice(0, 80)}) : dernière version gardée`); }
    }
    events = c.calendar?.events ?? [];
  }
  const calendar = calendarWindow(events, now, cfg), metrics = marketMetrics(live, markets, cfg), eps = epsilonSignal(epsilon, cfg);
  const quant = classifyRegime({ calendar, metrics, eps }, cfg);
  const llm = await llmSynthesis({ router, ranking, quant, metrics, calendar, epsilon, now, cache: c.llm, cfg });
  if (llm && !llm.error && !llm.stale) c.llm = { at: llm.at, key: llm.key, model: llm.model, regime: llm.regime, confidence: llm.confidence, rationale: llm.rationale };
  if (llm?.error) notes.push(`synthèse LLM : ${llm.error}`);
  // le LLM nuance un régime « mou » s'il est assez sûr ; jamais un stress dur (calendrier, krach, choc de volatilité)
  let regime = quant.regime, source = "règles";
  if (llm && !llm.error && llm.regime && llm.regime !== quant.regime && !quant.hard && llm.confidence >= cfg.llmOverrideConfidence) { regime = llm.regime; source = `LLM (${llm.model})`; }
  else if (llm && !llm.error && llm.regime === quant.regime) source = `règles, confirmé par ${llm.model}`;
  const out = { at: iso(now), regime, label: REGIME_LABEL[regime], source, confidence: source.startsWith("LLM") ? llm.confidence : quant.confidence, hard: quant.hard,
    reasons: quant.reasons, quant: quant.regime,
    llm: llm && !llm.error ? { regime: llm.regime, confidence: llm.confidence, rationale: llm.rationale, model: llm.model, at: llm.at, cached: !!llm.cached } : llm?.error ? { error: llm.error } : null,
    calendar: { next: calendar.next, inWindow: calendar.inWindow, upcoming: calendar.upcoming, refreshedAt: c.calendar?.at ? iso(c.calendar.at) : null },
    metrics, eps, policy: policySummary(regime), risk: regimeRisk(regime, cfg), notes };
  c.last = { at: out.at, regime, source };
  return { regime: out, cache: c };
}

/* ---------------- politique par famille ---------------- */

const POLICY = {
  MACRO_EVENT_STRESS: { trend_breakout: 0, mean_reversion: 0, volatility_squeeze: 0, stat_arb_leadlag: 1, defensive_hedge: 1 },
  RANGE_COMPRESSION: { trend_breakout: 0.5, mean_reversion: 1.25, volatility_squeeze: 1, stat_arb_leadlag: 1.25, defensive_hedge: 1 },
  TREND_RISK_ON: { trend_breakout: 1.25, mean_reversion: 1, volatility_squeeze: 1.25, stat_arb_leadlag: 1, defensive_hedge: 1 },
  SQUEEZE_CROWDED: { trend_breakout: 1.25, mean_reversion: 1, volatility_squeeze: 1.25, stat_arb_leadlag: 1, defensive_hedge: 1 },
  RISK_OFF_CRASH: { trend_breakout: 1, mean_reversion: 1, volatility_squeeze: 1.25, stat_arb_leadlag: 1, defensive_hedge: 1.25 },
};
const regimeOf = (r) => (typeof r === "string" ? r : r?.regime ?? null);

// Poids d'une stratégie dans le meta-ensemble selon le régime (1 sans régime). side : sens du Blueprint (long, short, both).
export function familyWeight(regime, family, side = "both") {
  const R = regimeOf(regime);
  if (!R || !POLICY[R]) return 1;
  if (R === "RISK_OFF_CRASH" && family === "trend_breakout" && side === "long") return 0;   // tendance purement acheteuse coupée
  return POLICY[R][family] ?? 1;
}

// Ouverture d'une position (D2/D3, signal d'un champion) : 0 = interdite. dir : +1 achat, −1 vente ; trendDir : sens de la
// tendance 72 h du ticker (0 inconnu).
export function entryGate(regime, family, dir, trendDir = 0, side = "both") {
  const R = regimeOf(regime), w = familyWeight(R, family, side);
  if (w === 0) return 0;
  if ((R === "TREND_RISK_ON" || R === "SQUEEZE_CROWDED") && family === "mean_reversion" && trendDir && dir === -trendDir) return 0;   // contre-tendance
  if (R === "RISK_OFF_CRASH" && family === "trend_breakout" && dir > 0) return 0;
  return w;
}

// Sens de la tendance 72 h d'une série à la barre i
export const trendDirAt = (s, i, k = 72) => (s?.c && i >= 1 ? Math.sign(s.c[i] / s.c[Math.max(0, i - k)] - 1) : 0);

export function policySummary(regime) {
  const R = regimeOf(regime), fam = ["trend_breakout", "mean_reversion", "stat_arb_leadlag", "volatility_squeeze", "defensive_hedge"];
  const rows = fam.map((f) => {
    const w = familyWeight(R, f), cond = (R === "TREND_RISK_ON" || R === "SQUEEZE_CROWDED") && f === "mean_reversion" ? "pas de contre-tendance"
      : R === "RISK_OFF_CRASH" && f === "trend_breakout" ? "pas d'achat" : null;
    return { family: f, weight: w, status: w === 0 ? "coupée" : w > 1 ? "favorisée" : w < 1 ? "atténuée" : cond ? "restreinte" : "autorisée", cond };
  });
  return { families: rows, allowed: rows.filter((r) => r.weight > 0).map((r) => r.family), cut: rows.filter((r) => r.weight === 0).map((r) => r.family) };
}

// Ajustement du risque des nouvelles ouvertures (risk.mjs lit cfg.regime)
export function regimeRisk(regime, cfg = REGIME_CFG) {
  const R = regimeOf(regime);
  return STRESS.includes(R) ? { regime: R, sizeMult: cfg.stressRisk.sizeMult, minConviction: cfg.stressRisk.minConviction } : { regime: R, sizeMult: 1, minConviction: null };
}
export const withRegime = (config, regime, cfg = REGIME_CFG) => ({ ...config, regime: regimeRisk(regime, cfg) });

// Contexte compact pour les votants LLM
export function regimeContext(r) {
  if (!r?.regime) return null;
  return { regime: r.regime, label: r.label, reasons: r.reasons.slice(0, 3), next_event: r.calendar?.next ? `${r.calendar.next.cur} ${r.calendar.next.title} dans ${r.calendar.next.inMin} min` : null,
    min_conviction: r.risk?.minConviction ?? null, size_multiplier: r.risk?.sizeMult ?? 1, strategy_families_cut: r.policy?.cut ?? [] };
}
