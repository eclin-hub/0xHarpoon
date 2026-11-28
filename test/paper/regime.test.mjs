// Méta-Agent de Régime Macro (regime_agent.mjs) : calendrier économique, classement des 5 régimes, synthèse LLM en cache,
// pilotage des familles de stratégies en D2/D3 et dans le meta-ensemble, risque réduit en régime de stress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMacroRegime, calendarWindow, classifyRegime, marketMetrics, epsilonSignal, familyWeight, entryGate, policySummary, regimeRisk, withRegime,
  llmCacheValid, isCritical, REGIMES } from "../../lib/paper/regime_agent.mjs";
import { inferFamily } from "../../lib/paper/blueprint.mjs";
import { championSignals, stepLeagues, emptyLeagues } from "../../lib/paper/league_engine.mjs";
import { newBook, stepBook } from "../../lib/paper/blueprint_eval.mjs";
import { metaWeights, META } from "../../lib/paper/router.mjs";
import { riskPerTrade, sizeHl, sizePm, MODES } from "../../lib/paper/risk.mjs";
import { CONFIG } from "../../lib/paper/config.mjs";
import { initialPortfolio } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 11, 9, 15), H = 3600e3;
const ev = (title, inH, cur = "USD", impact = "High") => ({ title, cur, t: NOW + inH * H, impact });
// série horaire : n barres, dérive par barre, bruit alterné ; fin optionnelle (choc)
function series(n = 300, drift = 0, noise = 0.004, tail = []) {
  const c = [100];
  for (let i = 1; i < n; i++) c.push(c[i - 1] * (1 + drift + (i % 2 ? noise : -noise) * (1 + (i % 7) / 7)));
  for (const r of tail) c.push(c.at(-1) * (1 + r));
  return { t: c.map((_, i) => NOW - (c.length - i) * H), c, h: c, l: c, funding: c.map(() => 0), xVel: c.map(() => 1), xBias: c.map(() => 0), pm: c.map(() => 0) };
}
const calm = () => ({ series: { BTC: series(), ETH: series(), NVDA: series(), BRENTOIL: series() } });

test("(1) événement FOMC / CPI à moins de 4 h → MACRO_EVENT_STRESS, même sur un marché calme ; fenêtre −4 h / +2 h", async () => {
  const { regime: quiet } = await evaluateMacroRegime({ calendarEvents: [], live: calm(), now: NOW });
  assert.notEqual(quiet.regime, "MACRO_EVENT_STRESS");
  for (const e of [ev("FOMC Statement", 3.5), ev("CPI m/m", 0.5), ev("Core PCE Price Index m/m", -1.5), ev("Non-Farm Employment Change", 2), ev("Main Refinancing Rate", 1, "EUR")]) {
    const { regime: r } = await evaluateMacroRegime({ calendarEvents: [e], live: calm(), now: NOW });
    assert.equal(r.regime, "MACRO_EVENT_STRESS", e.title); assert.equal(r.hard, true);
    assert.match(r.reasons[0], new RegExp(e.title.split(" ")[0]));
    assert.deepEqual(r.policy.cut, ["trend_breakout", "mean_reversion", "volatility_squeeze"]);
    assert.deepEqual(r.risk, { regime: "MACRO_EVENT_STRESS", sizeMult: 0.5, minConviction: 70 });
  }
  // hors fenêtre (5 h avant, 3 h après), événement mineur ou d'une autre devise : pas de stress de calendrier
  for (const e of [ev("FOMC Statement", 5), ev("CPI m/m", -3), ev("CPI m/m", 1, "AUD"), ev("Building Permits", 1, "USD", "Medium"), ev("Unemployment Claims", 1)]) {
    const { regime: r } = await evaluateMacroRegime({ calendarEvents: [e], live: calm(), now: NOW });
    assert.notEqual(r.regime, "MACRO_EVENT_STRESS", `${e.cur} ${e.title} ${(e.t - NOW) / H} h`);
  }
  const w = calendarWindow([ev("FOMC Statement", 26), ev("CPI m/m", 50)], NOW);
  assert.equal(w.next.title, "FOMC Statement"); assert.equal(w.next.inMin, 26 * 60); assert.equal(w.inWindow.length, 0);
  assert.ok(isCritical(ev("Federal Funds Rate", 1))); assert.ok(!isCritical(ev("Federal Funds Rate", 1, "USD", "Medium")));
});

test("5 régimes : krach, choc de volatilité, squeeze, tendance, compression", () => {
  const cal = calendarWindow([], NOW), eps0 = epsilonSignal({});
  const reg = (live, eps = eps0, markets = {}) => classifyRegime({ calendar: cal, metrics: marketMetrics(live, markets), eps }).regime;
  assert.equal(reg({ series: { BTC: series(300, 0, 0.004, [-0.02, -0.02, -0.02, -0.01]) } }), "RISK_OFF_CRASH");
  assert.equal(reg({ series: { BTC: series(300, 0, 0.002, Array.from({ length: 24 }, (_, i) => (i % 2 ? 0.012 : -0.012))) } }), "MACRO_EVENT_STRESS");   // choc de volatilité
  const hotX = epsilonSignal({ BTC: { active: true, squeezeWarning: true, mentionVelocityRatio: 3, netNarrativeBias: 0.6 } });
  assert.equal(reg(calm(), hotX, { BTC: { funding: 0.00015 } }), "SQUEEZE_CROWDED");
  assert.equal(reg(calm(), eps0, { BTC: { funding: 0.00015 } }), "RANGE_COMPRESSION");                              // funding seul : pas de squeeze
  assert.equal(reg({ series: { BTC: series(300, 0.0012, 0.003), ETH: series(300, 0.0012, 0.003) } }), "TREND_RISK_ON");
  assert.equal(reg({ series: { BTC: series(300, 0, 0.004, Array.from({ length: 24 }, (_, i) => (i % 2 ? 0.001 : -0.001))) } }), "RANGE_COMPRESSION");
  assert.equal(REGIMES.length, 5);
});

test("synthèse LLM : deepseek-v4-pro d'abord, puis le meilleur votant actif ; cache 2 h invalidé dès qu'un événement entre dans la fenêtre ; jamais de levée d'un stress dur", async () => {
  const calls = [];
  const router = { collect: async (n, messages, validate, opts) => { calls.push(opts.prefer); return { results: [{ model: opts.prefer?.[0] ?? "x", value: validate({ regime: "TREND_RISK_ON", confidence: 85, rationale: "Tendance propre." }).value }], errors: [] }; } };
  const ranking = { active: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"], order: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"] };
  let r = await evaluateMacroRegime({ calendarEvents: [], live: calm(), router, ranking, now: NOW });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 2), ["deepseek-v4-pro", "openai/gpt-oss-120b"]);   // deepseek-v4-pro, puis le meilleur actif
  assert.equal(r.regime.regime, "TREND_RISK_ON"); assert.match(r.regime.source, /^LLM/);        // régime « mou » nuancé par un LLM sûr de lui
  r = await evaluateMacroRegime({ calendarEvents: [], live: calm(), router, ranking, cache: r.cache, now: NOW + H });
  assert.equal(calls.length, 1); assert.equal(r.regime.llm.cached, true);                      // cache de 2 h
  r = await evaluateMacroRegime({ calendarEvents: [ev("CPI m/m", 2.5)], live: calm(), router, ranking, cache: r.cache, now: NOW + H });
  assert.equal(calls.length, 2);                                                                // l'événement entre dans la fenêtre : cache invalidé
  assert.equal(r.regime.regime, "MACRO_EVENT_STRESS"); assert.equal(r.regime.source, "règles"); // le LLM ne lève pas un stress dur
  assert.ok(!llmCacheValid(r.cache.llm, "", NOW + 4 * H));
  const r2 = await evaluateMacroRegime({ calendarEvents: [], live: calm(), router, ranking, cache: r.cache, now: NOW + 3.5 * H });
  assert.equal(calls.length, 3);                                                                // fenêtre refermée, cache expiré : nouvel appel
  // LLM en échec : régime des règles, raison dans les notes
  const bad = { collect: async () => ({ results: [], errors: ["groq/x : HTTP 429"] }) };
  const r3 = await evaluateMacroRegime({ calendarEvents: [], live: calm(), router: bad, ranking, now: NOW });
  assert.equal(r3.regime.source, "règles"); assert.match(r3.regime.notes[0], /HTTP 429/);
  // calendrier relu au plus toutes les 60 min ; ancienne version gardée si la source tombe
  let fetches = 0; const fc = async () => { fetches++; return { events: [ev("FOMC Statement", 1)] }; };
  const a = await evaluateMacroRegime({ fetchCalendar: fc, live: calm(), now: NOW });
  const b = await evaluateMacroRegime({ fetchCalendar: fc, live: calm(), cache: a.cache, now: NOW + 30 * 60e3 });
  assert.equal(fetches, 1); assert.equal(b.regime.regime, "MACRO_EVENT_STRESS");
  const c = await evaluateMacroRegime({ fetchCalendar: async () => { throw new Error("HTTP 503"); }, live: calm(), cache: a.cache, now: NOW + 61 * 60e3 });
  assert.equal(c.regime.regime, "MACRO_EVENT_STRESS"); assert.match(c.regime.notes[0], /calendrier indisponible/);
});

/* ---------- familles et pilotage des ligues ---------- */

const MR = { name: "Retour à la moyenne", thesis: "z-score et RSI.", universe: ["BTC"], side: "both", horizon_hours: 24,
  blocks: [{ type: "bollinger_zscore", weight: 0.6, params: { period: 20, z: 2 } }, { type: "rsi", weight: 0.4, params: { period: 14, low: 30, high: 70 } }],
  entry: { score_above: 0.1 }, exit: { stop_atr: 2, take_profit_atr: 3, max_hold_hours: 24 } };
const SA = { ...MR, name: "Lead-lag X", thesis: "Vélocité X.", blocks: [{ type: "x_velocity_bias", weight: 1, params: { min_velocity: 1.5, min_bias: 0.2 } }] };
const TR = { ...MR, name: "Momentum", thesis: "Suivre la tendance.", side: "long", blocks: [{ type: "momentum", weight: 1, params: { lookback: 24 } }] };

test("familles : déduites des règles (signes compris) ; Blueprints déjà compilés typés au cycle suivant", () => {
  assert.equal(inferFamily(MR), "mean_reversion");
  assert.equal(inferFamily(SA), "stat_arb_leadlag");
  assert.equal(inferFamily(TR), "trend_breakout");
  assert.equal(inferFamily({ ...TR, blocks: [{ type: "momentum", weight: -1, params: {} }] }), "mean_reversion");        // momentum inversé
  assert.equal(inferFamily({ ...MR, blocks: [{ type: "rsi", weight: -0.8, params: {} }] }), "trend_breakout");          // RSI inversé
  assert.equal(inferFamily({ ...TR, blocks: [{ type: "volatility_regime", weight: 0.5, params: {} }, { type: "atr_breakout", weight: 1, params: {} }] }), "volatility_squeeze");
  assert.equal(inferFamily({ ...TR, side: "short" }), "defensive_hedge");
  assert.equal(inferFamily({ ...MR, thesis: "Couverture contre un krach." }), "defensive_hedge");
  assert.equal(inferFamily({ ...MR, blocks: [{ type: "linear_ml_score", weight: 1, params: { features: ["x_bias", "pm_move", "momentum"], coefs: [2, 1, 0.5] } }] }), "stat_arb_leadlag");
  const st = stepLeagues({ ...emptyLeagues(), entries: [{ id: "old", name: "old", blueprint: MR, division: "OUT" }] }, { series: {} }, { now: NOW });
  assert.equal(st.entries[0].family, "mean_reversion");
});

test("(2) MACRO_EVENT_STRESS : un champion D3 mean_reversion passe à weight = 0 dans le meta-ensemble ; stat_arb garde son poids", () => {
  // série qui finit sur un décrochage : le retour à la moyenne veut acheter ; X très haussier pour le lead-lag
  const s = series(200, 0, 0.003, [-0.01, -0.012, -0.015]); s.xVel = s.c.map(() => 3); s.xBias = s.c.map(() => 0.8);
  const live = { series: { BTC: s } };
  const d3 = (id, bp) => ({ id, name: id, blueprint: bp, division: "D3", d2: { metrics: { psr: 0.9 }, book: newBook() }, d3: { rollingPsr: 0.9 } });
  const st = { ...emptyLeagues(), entries: [d3("mr", MR), d3("sa", SA)] };
  const free = championSignals(st, live);
  assert.ok(free.every((c) => Object.keys(c.signals).length === 1), JSON.stringify(free));
  const mw0 = metaWeights(free, null);
  assert.ok(mw0.champions.every((c) => c.weight > 0));
  const ch = championSignals(st, live, "MACRO_EVENT_STRESS");
  assert.deepEqual(ch.map((c) => [c.family, c.regimeMult]), [["mean_reversion", 0], ["stat_arb_leadlag", 1]]);
  const mw = metaWeights(ch, null);
  assert.equal(mw.champions.find((c) => c.id === "mr").weight, 0);
  assert.equal(mw.champions.find((c) => c.id === "sa").weight, META.d3Weight);                  // la part D3 entière revient au lead-lag
  // tous coupés : les LLM reprennent 100 %
  const only = metaWeights(championSignals({ ...st, entries: [d3("mr", MR)] }, live, "MACRO_EVENT_STRESS"), null);
  assert.equal(only.llm, 1); assert.equal(only.d3, 0); assert.equal(only.champions[0].weight, 0);
  // RANGE_COMPRESSION : mean_reversion × 1,25 contre trend × 0,5
  assert.equal(familyWeight("RANGE_COMPRESSION", "mean_reversion"), 1.25); assert.equal(familyWeight("RANGE_COMPRESSION", "trend_breakout"), 0.5);
});

test("D2/D3 : une famille coupée n'ouvre plus de position (sorties intactes) ; contre-tendance et achat en krach écartés", () => {
  const s = series(200, 0, 0.003, [-0.01, -0.012, -0.015]), live = { series: { BTC: s } }, i = s.c.length - 1;
  const run = (regime) => { const st = { ...emptyLeagues(), entries: [{ id: "mr", name: "mr", blueprint: MR, division: "D2", d2: { since: new Date(NOW).toISOString(), book: newBook(), metrics: null } }] };
    return stepLeagues(st, live, { now: NOW, regime: regime ? { regime } : null }).entries[0]; };
  assert.equal(Object.keys(run(null).d2.book.positions).length, 1);                              // sans régime : il achète le creux
  const cut = run("MACRO_EVENT_STRESS");
  assert.equal(Object.keys(cut.d2.book.positions).length, 0); assert.equal(cut.d2.book.gated, 1); assert.equal(cut.regimeWeight, 0);
  // une position ouverte reste gérée par ses stops et sorties même si le régime coupe la famille
  const b = newBook(); stepBook(b, MR, live.series, () => i, NOW);
  assert.equal(Object.keys(b.positions).length, 1);
  const s2 = { ...s, c: [...s.c, s.c.at(-1) * 0.8], h: [...s.c, s.c.at(-1) * 0.8], l: [...s.c, s.c.at(-1) * 0.8] };
  stepBook(b, MR, { BTC: s2 }, () => i + 1, NOW + H, undefined, () => 0);
  assert.equal(b.trades.at(-1).reason, "stop");
  // tendance : mean_reversion à contre-sens interdite ; krach : achat de tendance interdit
  assert.equal(entryGate("TREND_RISK_ON", "mean_reversion", -1, +1), 0); assert.equal(entryGate("TREND_RISK_ON", "mean_reversion", +1, +1), 1);
  assert.equal(entryGate("RISK_OFF_CRASH", "trend_breakout", +1, -1), 0); assert.equal(entryGate("RISK_OFF_CRASH", "trend_breakout", -1, -1), 1);
  assert.equal(familyWeight("RISK_OFF_CRASH", "trend_breakout", "long"), 0); assert.equal(familyWeight("RISK_OFF_CRASH", "defensive_hedge"), 1.25);
  assert.deepEqual(policySummary("RISK_OFF_CRASH").cut, []);
  assert.equal(policySummary("RISK_OFF_CRASH").families.find((f) => f.family === "trend_breakout").status, "restreinte");
});

test("(3) risque en stress : taille × 0,5 et conviction minimale 70 (MACRO_EVENT_STRESS, RISK_OFF_CRASH) ; inchangé sinon", () => {
  const stress = withRegime(CONFIG, "MACRO_EVENT_STRESS"), crash = withRegime(CONFIG, "RISK_OFF_CRASH"), trend = withRegime(CONFIG, "TREND_RISK_ON");
  assert.deepEqual(regimeRisk("TREND_RISK_ON"), { regime: "TREND_RISK_ON", sizeMult: 1, minConviction: null });
  for (const cfg of [stress, crash]) {
    assert.equal(riskPerTrade(65, MODES.normal, cfg), 0);                                        // 65 suffisait, plus en stress
    assert.equal(riskPerTrade(69, MODES.normal, cfg), 0);
    assert.ok(riskPerTrade(70, MODES.normal, cfg) > 0);
  }
  assert.ok(riskPerTrade(65, MODES.normal, CONFIG) > 0); assert.ok(riskPerTrade(65, MODES.normal, trend) > 0);
  const req = { coin: "BTC", side: "long", pocket: "core", price: 100, atr: 2 };
  const low = sizeHl(initialPortfolio(), { ...req, conviction: 65 }, stress);
  assert.equal(low.ok, false); assert.match(low.reason ?? low.rejected?.reason ?? JSON.stringify(low), /65 < 70.*MACRO_EVENT_STRESS/);
  for (const conviction of [70, 85, 100]) {
    // même conviction, rMin repris à 70 : on compare à la taille normale calculée avec un seuil de 70
    const normal = sizeHl(initialPortfolio(), { ...req, conviction }, { ...CONFIG, ai: { ...CONFIG.ai, minConviction: 70 } });
    const half = sizeHl(initialPortfolio(), { ...req, conviction }, stress);
    assert.ok(normal.ok && half.ok);
    assert.ok(Math.abs(half.order.usd - normal.order.usd * 0.5) < 1e-6, `${half.order.usd} ≠ ${normal.order.usd} / 2`);
    assert.match(half.order.binding, /régime MACRO_EVENT_STRESS × 0.5/);
  }
  // même quand un plafond limite la taille, le régime la divise encore par deux
  const capped = sizeHl(initialPortfolio(), { ...req, conviction: 100, atr: 0.01 }, { ...CONFIG, ai: { ...CONFIG.ai, minConviction: 70 } });
  const cappedHalf = sizeHl(initialPortfolio(), { ...req, conviction: 100, atr: 0.01 }, stress);
  assert.notEqual(capped.order.binding, "risque R");
  assert.ok(Math.abs(cappedHalf.order.usd - capped.order.usd * 0.5) < 1e-6);
  const pm = (cfg) => sizePm(initialPortfolio(), { token: "1", cid: "0x1", pocket: "core", conviction: 80, price: 0.5 }, cfg, NOW);
  assert.ok(Math.abs(pm(stress).order.usd - pm({ ...CONFIG, ai: { ...CONFIG.ai, minConviction: 70 } }).order.usd * 0.5) < 1e-6);
});
