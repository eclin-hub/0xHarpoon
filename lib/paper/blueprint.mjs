// Blueprints stratégiques (Flux ∞) : une stratégie lue sur X, traduite par un LLM en JSON purement déclaratif.
// Aucun code n'est exécuté : chaque bloc est un type connu dont les paramètres sont des nombres bornés,
// combinés par une somme pondérée que le moteur saura calculer sur nos données (bougies HL, X, Polymarket).
// Tout champ inconnu, type absent de la liste ou valeur hors bornes invalide le Blueprint.

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
  if (!Array.isArray(bp.universe) || !bp.universe.length || bp.universe.some((t) => !TICKERS.includes(t))) errs.push(`universe : tickers parmi ${TICKERS.join(", ")}`);
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

export const BLUEPRINT_PROMPT = `You convert one trading idea posted on X into a declarative JSON blueprint. Never write code or formulas as strings.
Use only these block types and numeric params (omit a param to use the default):
${Object.entries(BLOCKS).map(([t, p]) => `- ${t}: ${Object.entries(p).map(([k, [a, b]]) => `${k} ${a}..${b}`).join(", ")}${t === "linear_ml_score" ? `, features (subset of ${ML_FEATURES.join(", ")}), coefs (one number -5..5 per feature)` : ""}`).join("\n")}
Universe: subset of ${TICKERS.join(", ")} (closest liquid proxy if the post names another asset).
Answer with JSON only:
{"name":"<short name>","thesis":"<1-2 sentences in French>","universe":["BTC"],"side":"long|short|both","horizon_hours":24,
 "blocks":[{"type":"rsi","weight":0.5,"params":{"period":14,"low":30,"high":70}}],"entry":{"score_above":0.3},"exit":{"stop_atr":2,"take_profit_atr":4,"max_hold_hours":48}}
Block weights are in -1..1 and combine into a score in -1..1. If the post contains no testable rule, answer {"none":true}.`;
