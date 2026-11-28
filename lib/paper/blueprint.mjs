// Blueprints stratégiques (Flux ∞) : une stratégie lue sur X, traduite par un LLM en JSON purement déclaratif.
// Aucun code n'est exécuté : chaque bloc est un type connu dont les paramètres sont des nombres bornés,
// combinés par une somme pondérée que le moteur saura calculer sur nos données (bougies HL, X, Polymarket).
// Tout champ inconnu, type absent de la liste ou valeur hors bornes invalide le Blueprint.

import { validAsset, normalizeAsset, GROUPS, UNIVERSE_CFG } from "./universe.mjs";

// 8 tickers historiques (flux ε, séries des ligues d'origine). L'univers d'un Blueprint n'y est plus limité : tout actif
// Hyperliquid, tout marché Polymarket et les groupes ALL_HL / HL_CRYPTO / HL_TRADFI / ALL_PM (universe.mjs).
export const TICKERS = Object.freeze(["BTC", "ETH", "SOL", "HYPE", "ZEC", "NVDA", "SOXL", "BRENTOIL"]);
export const ML_FEATURES = Object.freeze(["momentum", "rsi", "zscore", "atr_pct", "funding", "x_bias", "x_velocity", "pm_move"]);

// type → { paramètre: [min, max] } ; « features »/« coefs » du score linéaire sont traités à part
export const BLOCKS = Object.freeze({
  momentum: { lookback: [2, 200] },
  rsi: { period: [2, 50], low: [5, 50], high: [50, 95] },
  bollinger_zscore: { period: [5, 100], z: [0.5, 4] },
  atr_breakout: { period: [5, 50], mult: [0.5, 5] },
  volatility_regime: { lookback: [5, 200], max_atr_pct: [0.001, 0.5] },
  x_velocity_bias: { min_velocity: [1, 10], min_bias: [-1, 1] },
  polymarket_edge: { min_move: [0.01, 0.5] },
  linear_ml_score: { intercept: [-5, 5] },
});

const isNum = (x, [lo, hi]) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const isStr = (x, max) => typeof x === "string" && x.trim().length > 0 && x.length <= max;
const onlyKeys = (o, keys, where, errs) => { for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${where} : champ inconnu « ${k} »`); };

export function validateBlueprint(bp) {
  const errs = [];
  if (!bp || typeof bp !== "object" || Array.isArray(bp)) return { ok: false, errors: ["objet JSON attendu"] };
  onlyKeys(bp, ["name", "thesis", "universe", "side", "horizon_hours", "blocks", "entry", "exit"], "blueprint", errs);
  if (!isStr(bp.name, 80)) errs.push("name : texte de 1 à 80 caractères");
  if (!isStr(bp.thesis, 400)) errs.push("thesis : texte de 1 à 400 caractères");
  if (!Array.isArray(bp.universe) || !bp.universe.length || bp.universe.length > UNIVERSE_CFG.maxItems || bp.universe.some((t) => !validAsset(t)))
    errs.push(`universe : 1 à ${UNIVERSE_CFG.maxItems} actifs (symbole Hyperliquid, PM:<conditionId>|<issue>, ou ${GROUPS.join(", ")})`);
  if (!["long", "short", "both"].includes(bp.side)) errs.push("side : long, short ou both");
  if (!isNum(bp.horizon_hours, [1, 720])) errs.push("horizon_hours : 1 à 720");
  if (!Array.isArray(bp.blocks) || bp.blocks.length < 1 || bp.blocks.length > 6) errs.push("blocks : 1 à 6 blocs");
  else bp.blocks.forEach((b, i) => {
    const w = `blocks[${i}]`;
    if (!b || typeof b !== "object") return errs.push(`${w} : objet attendu`);
    onlyKeys(b, ["type", "weight", "params"], w, errs);
    const spec = BLOCKS[b.type];
    if (!spec) return errs.push(`${w}.type : ${Object.keys(BLOCKS).join(", ")}`);
    if (!isNum(b.weight, [-1, 1])) errs.push(`${w}.weight : -1 à 1`);
    const p = b.params ?? {};
    if (typeof p !== "object" || Array.isArray(p)) return errs.push(`${w}.params : objet attendu`);
    const extra = b.type === "linear_ml_score" ? ["features", "coefs"] : [];
    onlyKeys(p, [...Object.keys(spec), ...extra], `${w}.params`, errs);
    for (const [k, range] of Object.entries(spec)) if (p[k] !== undefined && !isNum(p[k], range)) errs.push(`${w}.params.${k} : ${range[0]} à ${range[1]}`);
    if (b.type === "linear_ml_score") {
      const f = p.features, c = p.coefs;
      if (!Array.isArray(f) || !f.length || f.length > 8 || f.some((x) => !ML_FEATURES.includes(x))) errs.push(`${w}.params.features : parmi ${ML_FEATURES.join(", ")}`);
      if (!Array.isArray(c) || c.length !== f?.length || c.some((x) => !isNum(x, [-5, 5]))) errs.push(`${w}.params.coefs : un coefficient (-5 à 5) par feature`);
    }
  });
  const en = bp.entry, ex = bp.exit;
  if (!en || typeof en !== "object") errs.push("entry : objet attendu");
  else { onlyKeys(en, ["score_above"], "entry", errs); if (!isNum(en.score_above, [-1, 1])) errs.push("entry.score_above : -1 à 1"); }
  if (!ex || typeof ex !== "object") errs.push("exit : objet attendu");
  else {
    onlyKeys(ex, ["stop_atr", "take_profit_atr", "max_hold_hours"], "exit", errs);
    if (!isNum(ex.stop_atr, [0.5, 5])) errs.push("exit.stop_atr : 0.5 à 5");
    if (ex.take_profit_atr !== undefined && !isNum(ex.take_profit_atr, [0.5, 10])) errs.push("exit.take_profit_atr : 0.5 à 10");
    if (!isNum(ex.max_hold_hours, [1, 720])) errs.push("exit.max_hold_hours : 1 à 720");
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true, value: bp };
}

// catalog : liste des actifs disponibles ce cycle (universe.catalogPrompt), ou null (liste générique)
export const blueprintPrompt = (catalog = null) => `You convert one trading idea (an X post, or an arXiv quantitative-finance abstract) into a declarative JSON blueprint. Never write code or formulas as strings.
Use only these block types and numeric params (omit a param to use the default):
${Object.entries(BLOCKS).map(([t, p]) => `- ${t}: ${Object.entries(p).map(([k, [a, b]]) => `${k} ${a}..${b}`).join(", ")}${t === "linear_ml_score" ? `, features (subset of ${ML_FEATURES.join(", ")}), coefs (one number -5..5 per feature)` : ""}`).join("\n")}
Universe: first identify the strategy's logic (crypto stat-arb or momentum, oil / commodity shock, AI / tech equities, macro or political
probabilities on Polymarket…), then pick the BEST target assets for it among everything available, not only the majors:
- a targeted list of 5 to 20 assets (Hyperliquid symbols exactly as listed, e.g. "DOGE", "xyz:CL"; Polymarket outcomes as "PM:<id>|<outcome>"),
- or a whole group: "ALL_HL" (most liquid Hyperliquid perps), "HL_CRYPTO" (crypto perps), "HL_TRADFI" (equities, indices, commodities),
  "ALL_PM" (active Polymarket markets; a Polymarket "price" is the outcome's odds between 0 and 1).
${catalog ? `Available this hour:\n${catalog}` : `Hyperliquid majors: ${TICKERS.join(", ")} (any listed Hyperliquid perp is accepted).`}
Answer with JSON only:
{"name":"<short name>","thesis":"<1-2 sentences in French>","universe":["BTC"],"side":"long|short|both","horizon_hours":24,
 "blocks":[{"type":"rsi","weight":0.5,"params":{"period":14,"low":30,"high":70}}],"entry":{"score_above":0.3},"exit":{"stop_atr":2,"take_profit_atr":4,"max_hold_hours":48}}
Block weights are in -1..1 and combine into a score in -1..1.
For an arXiv abstract (source "arxiv"), the rule is rarely spelled out: approximate the paper's core signal with the closest blocks
(e.g. factor or ML model → linear_ml_score on momentum/zscore/atr_pct/funding; GARCH or volatility forecasting → volatility_regime
plus atr_breakout; statistical arbitrage, cointegration, mean reversion → bollinger_zscore; order flow or microstructure → momentum
with a short lookback; technical indicators → rsi, momentum, bollinger_zscore) on the closest liquid tickers (default BTC, ETH).
Answer {"none":true} only if the text has no tradable price signal at all (pure theory, pensions, insurance, credit, accounting).`;
export const BLUEPRINT_PROMPT = blueprintPrompt(null);
// Version du prompt : quand elle change, les posts jugés « sans règle testable » par une version antérieure sont réessayés.
export const BLUEPRINT_PROMPT_V = 3;

// Normalisation avant validation : les modèles rendent souvent un JSON presque correct (valeur hors bornes, ticker
// « xyz:NVDA », type « bollinger », champ en trop). On borne, on renomme les alias connus et on retire l'inconnu, puis
// validateBlueprint décide. Rien n'est inventé : sans bloc reconnu ni ticker utilisable, le Blueprint reste invalide.
const BLOCK_ALIASES = { bollinger: "bollinger_zscore", bollinger_bands: "bollinger_zscore", zscore: "bollinger_zscore", z_score: "bollinger_zscore",
  breakout: "atr_breakout", atr: "atr_breakout", volatility: "volatility_regime", vol_regime: "volatility_regime", regime: "volatility_regime",
  x_sentiment: "x_velocity_bias", sentiment: "x_velocity_bias", polymarket: "polymarket_edge", ml: "linear_ml_score", linear: "linear_ml_score",
  linear_model: "linear_ml_score", mom: "momentum", trend: "momentum", relative_strength_index: "rsi" };
const TICKER_ALIASES = { BITCOIN: "BTC", XBT: "BTC", ETHEREUM: "ETH", SOLANA: "SOL", HYPERLIQUID: "HYPE", ZCASH: "ZEC", NVIDIA: "NVDA", BRENT: "BRENTOIL", OIL: "BRENTOIL", CRUDE: "BRENTOIL", SOX: "SOXL" };
const clampTo = (x, [lo, hi], def) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

export function coerceBlueprint(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  // univers : alias (bitcoin → BTC, crude → xyz:CL…), casse, xyz:NVDA → NVDA (ticker historique), groupes ; inutilisable écarté
  const uni = [...new Set((Array.isArray(raw.universe) ? raw.universe : [raw.universe]).map((t) => normalizeAsset(TICKER_ALIASES[String(t ?? "").toUpperCase()] ?? t)).filter((t) => t && validAsset(t)))].slice(0, UNIVERSE_CFG.maxItems);
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map((b) => {
    const type = BLOCKS[String(b?.type ?? "").toLowerCase()] ? String(b.type).toLowerCase() : BLOCK_ALIASES[String(b?.type ?? "").toLowerCase()];
    if (!type) return null;
    const p = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {}, params = {};
    for (const [k, range] of Object.entries(BLOCKS[type])) if (p[k] !== undefined && Number.isFinite(Number(p[k]))) params[k] = clampTo(p[k], range);
    if (type === "linear_ml_score") {
      const pairs = (Array.isArray(p.features) ? p.features : []).map((f, i) => [String(f).toLowerCase(), clampTo(p.coefs?.[i], [-5, 5], null)]).filter(([f, c]) => ML_FEATURES.includes(f) && c != null).slice(0, 8);
      if (!pairs.length) return null;
      params.features = pairs.map(([f]) => f); params.coefs = pairs.map(([, c]) => c);
    }
    return { type, weight: clampTo(b.weight, [-1, 1], 0.5), params };
  }).filter(Boolean).slice(0, 6);
  const side = ["long", "short", "both"].includes(String(raw.side).toLowerCase()) ? String(raw.side).toLowerCase() : "both";
  const horizon = clampTo(raw.horizon_hours, [1, 720], 48);
  const ex = raw.exit && typeof raw.exit === "object" ? raw.exit : {};
  return {
    name: String(raw.name ?? "").trim().slice(0, 80), thesis: String(raw.thesis ?? "").trim().slice(0, 400), universe: uni, side, horizon_hours: horizon, blocks,
    entry: { score_above: clampTo(raw.entry?.score_above ?? raw.entry, [-1, 1], 0.3) },
    exit: { stop_atr: clampTo(ex.stop_atr, [0.5, 5], 2), ...(ex.take_profit_atr != null && Number.isFinite(Number(ex.take_profit_atr)) ? { take_profit_atr: clampTo(ex.take_profit_atr, [0.5, 10]) } : {}),
      max_hold_hours: clampTo(ex.max_hold_hours, [1, 720], horizon) },
  };
}

/* ---------------- famille de stratégie (pilotage par le régime macro, regime_agent.mjs) ---------------- */
// Déduite des règles du Blueprint, jamais du LLM : momentum et atr_breakout à poids positif suivent la tendance (négatif :
// retour à la moyenne) ; rsi et bollinger_zscore à poids positif reviennent à la moyenne (négatif : tendance) ; X et
// Polymarket sont des signaux d'avance (lead-lag) ; le score linéaire est réparti selon ses variables. Puis :
//   defensive_hedge    : stratégie vendeuse seulement, ou thèse de couverture (hedge, krach, risk-off, protection)
//   volatility_squeeze : filtre volatility_regime + cassure ATR, ou thèse de squeeze / compression de volatilité
//   sinon la composante dominante : trend_breakout, mean_reversion ou stat_arb_leadlag (égalité : trend_breakout).
// version des règles d'inférence : une stratégie typée par une version antérieure est retypée une fois (league_engine)
export const FAMILY_V = 2;
export const FAMILIES = Object.freeze(["trend_breakout", "mean_reversion", "stat_arb_leadlag", "volatility_squeeze", "defensive_hedge"]);
const FEATURE_FAMILY = { momentum: 1, atr_pct: 0, rsi: 1, zscore: 1, funding: 2, x_bias: 2, x_velocity: 2, pm_move: 2 };   // 1 : tendance si coef > 0
export function inferFamily(bp) {
  if (!bp || !Array.isArray(bp.blocks)) return "trend_breakout";
  const text = `${bp.name || ""} ${bp.thesis || ""}`;
  if (bp.side === "short" || /\b(hedg\w*|couverture|défensi\w*|defensive|tail.?risk|krach|crash|risk.?off|protection)\b/i.test(text)) return "defensive_hedge";
  const types = bp.blocks.map((b) => b.type);
  if ((types.includes("volatility_regime") && types.includes("atr_breakout")) || /\b(squeeze|compression|volatility (breakout|expansion)|expansion de volatilité)\b/i.test(text)) return "volatility_squeeze";
  // arbitrage statistique déclaré par le nom ou la thèse (paires, cointégration, lead-lag, désalignements entre actifs similaires)
  if (/stat.?arb|arbitrage statistique|statistical arbitrage|pairs?.?trad\w*|cointegr\w*|lead.?lag|désalignement|mispricing/i.test(text)) return "stat_arb_leadlag";
  const s = { trend_breakout: 0, mean_reversion: 0, stat_arb_leadlag: 0 };
  for (const b of bp.blocks) {
    const w = Number(b.weight) || 0, a = Math.abs(w);
    if (b.type === "momentum" || b.type === "atr_breakout") s[w >= 0 ? "trend_breakout" : "mean_reversion"] += a;
    else if (b.type === "rsi" || b.type === "bollinger_zscore") s[w >= 0 ? "mean_reversion" : "trend_breakout"] += a;
    else if (b.type === "x_velocity_bias" || b.type === "polymarket_edge") s.stat_arb_leadlag += a;
    else if (b.type === "linear_ml_score") {
      const f = b.params?.features || [], c = b.params?.coefs || [], tot = c.reduce((x, y) => x + Math.abs(y), 0) || 1;
      f.forEach((name, k) => {
        const share = (a * Math.abs(c[k] ?? 0)) / tot, kind = FEATURE_FAMILY[name], dir = Math.sign(c[k] ?? 0) * Math.sign(w || 1);
        if (kind === 2) s.stat_arb_leadlag += share;
        else if (kind === 1) s[dir >= 0 ? "trend_breakout" : "mean_reversion"] += share;
      });
    }
  }
  return Object.entries(s).sort((x, y) => y[1] - x[1] || (x[0] === "trend_breakout" ? -1 : y[0] === "trend_breakout" ? 1 : 0))[0][0];
}
