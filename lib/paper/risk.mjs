// Moteur de risque déterministe (SPEC §5). Appliqué après la décision IA, avant l'exécution.
// Il ne fait que calculer : tailles, stops, plafonds, mode de drawdown. Le simulateur exécute.
// Aucune entrée venue d'un LLM ne peut agrandir une taille : la conviction ne fait que choisir R entre rMin et rMax.
//
// Mesures :
// - Levier brut = Σ notionnel HL (au mark) + Σ valeur PM, rapporté à l'equity.
// - Exposition par facteur = |Σ notionnel HL signé| des positions du facteur (une paire long/short ne compte que pour son net).
//   Les paris Polymarket n'entrent pas dans les facteurs (perte bornée à la mise).
// - Occupation d'une poche = Σ coût restant des positions PM + Σ marge des positions HL
//   (notionnel / levier max par position ; poche border sans levier : notionnel entier).
import { CONFIG, factorOf } from "./config.mjs";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sgn = (side) => (side === "long" ? 1 : -1);
const DAY = 86400e3;

export const MODES = Object.freeze({ normal: "normal", halveR: "halveR", reduceOnly: "reduceOnly", killed: "killed" });

// Mode selon le drawdown. L'arrêt d'urgence est définitif : seul un humain peut le lever (en éditant portfolio_state.json).
export function nextMode(prevMode, dd, cfg = CONFIG) {
  const r = cfg.risk, at = (x) => dd >= x - 1e-9;   // tolérance : 1 − 9000/10000 vaut 0.0999… en virgule flottante
  if (prevMode === MODES.killed || at(r.ddKill)) return MODES.killed;
  if (at(r.ddReduceOnly)) return MODES.reduceOnly;
  if (at(r.ddHalveR)) return MODES.halveR;
  return MODES.normal;
}

const hlNotional = (q) => q.size * (q.mark || q.entryPx);
const pocketUsage = (q, cfg) => (q.venue === "pm" ? q.cost : hlNotional(q) / (q.pocket === "border" ? 1 : cfg.risk.maxPositionLeverage));

export function riskState(portfolio, cfg = CONFIG) {
  const equity = portfolio.equity, peak = Math.max(portfolio.peakEquity ?? equity, equity);
  const dd = peak > 0 ? 1 - equity / peak : 0;
  const factors = {}, pockets = { core: 0, portage: 0, border: 0 }, markets = {};
  let gross = 0;
  for (const q of portfolio.positions) {
    pockets[q.pocket] = (pockets[q.pocket] || 0) + pocketUsage(q, cfg);
    if (q.venue === "hl") {
      const n = hlNotional(q);
      gross += n;
      const f = q.factor || factorOf(q.coin);
      factors[f] = (factors[f] || 0) + sgn(q.side) * n;
    } else {
      gross += q.value ?? q.cost;
      if (q.cid) markets[q.cid] = (markets[q.cid] || 0) + q.cost;
    }
  }
  return { equity, dd, mode: nextMode(portfolio.mode, dd, cfg), gross, grossLev: equity > 0 ? gross / equity : Infinity, factors, pockets, markets };
}

// R (fraction de l'equity risquée) : rMin à 60 de conviction, rMax à 100, divisé par 2 en mode halveR, 0 si ouverture interdite.
export function riskPerTrade(conviction, mode, cfg = CONFIG) {
  const { rMin, rMax } = cfg.risk, min = cfg.ai.minConviction;
  if (mode === MODES.reduceOnly || mode === MODES.killed) return 0;
  if (!Number.isFinite(conviction) || conviction < min) return 0;
  const r = rMin + (rMax - rMin) * clamp((conviction - min) / (100 - min), 0, 1);
  return mode === MODES.halveR ? r / 2 : r;
}

// Stop selon la volatilité : d = clip(2 × ATR / prix, 3 %, 15 %).
export function hlStop(price, atr, side, cfg = CONFIG) {
  const r = cfg.risk, d = clamp((r.stopAtrMult * atr) / price, r.stopMin, r.stopMax);
  return { dStop: d, stopPx: side === "long" ? price * (1 - d) : price * (1 + d) };
}

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// Applique un plafond : garde la plus petite taille et note quelle limite a joué.
function capper(start, label) {
  const c = { usd: start, binding: label, caps: [] };
  c.cap = (value, name) => { c.caps.push({ name, value }); if (value < c.usd) { c.usd = Math.max(0, value); c.binding = name; } return c; };
  return c;
}

// Ordre Hyperliquid. req = { coin, side, pocket, conviction, price, atr, targetPx?, expiresAt? }
export function sizeHl(portfolio, req, cfg = CONFIG) {
  const st = riskState(portfolio, cfg), r = cfg.risk, E = st.equity, pocket = req.pocket || "core";
  if (pocket === "portage") return refuse("la poche portage n'accepte que Polymarket");
  if (!(req.price > 0) || !(req.atr > 0)) return refuse("prix ou ATR manquant");
  if (req.side !== "long" && req.side !== "short") return refuse("sens invalide");
  const R = riskPerTrade(req.conviction, st.mode, cfg);
  if (!R) return refuse(st.mode === MODES.normal || st.mode === MODES.halveR ? `conviction ${req.conviction} < ${cfg.ai.minConviction}` : `mode ${st.mode} : aucune ouverture`);
  const { dStop, stopPx } = hlStop(req.price, req.atr, req.side, cfg);
  const border = pocket === "border";
  if (border) {
    if (!req.expiresAt) return refuse("poche border : catalyseur daté (expiresAt) obligatoire");
    const rr = req.targetPx ? Math.abs(req.targetPx - req.price) / (req.price * dStop) : 0;
    if (rr < cfg.pockets.border.minRewardRisk) return refuse(`poche border : gain/risque ${rr.toFixed(2)} < ${cfg.pockets.border.minRewardRisk}`);
  }
  const lev = border ? cfg.pockets.border.leverage : r.maxPositionLeverage;
  const f = factorOf(req.coin), net = st.factors[f] || 0, s = sgn(req.side), capF = r.factorCap * E;
  const c = capper((R * E) / dStop, "risque R")
    .cap(r.perPositionEquityCap * E * r.maxPositionLeverage, "plafond par position")
    .cap(r.maxGrossLeverage * E - st.gross, "levier brut global")
    .cap(s * net >= 0 ? capF - Math.abs(net) : capF + Math.abs(net), `facteur ${f}`)
    .cap((cfg.pockets[pocket].maxShare * E - (st.pockets[pocket] || 0)) * lev, `poche ${pocket}`);
  if (border) c.cap(cfg.pockets.border.perIdeaUsd * (R / r.rMax), "mise par idée border");
  if (c.usd < r.minOrderUsd) return refuse(`taille ${c.usd.toFixed(2)} $ < minimum (limite : ${c.binding})`, { caps: c.caps });
  return { ok: true, order: { venue: "hl", coin: req.coin, side: req.side, pocket, usd: c.usd, stopPx, dStop, R, riskUsd: c.usd * dStop, factor: f,
    expiresAt: req.expiresAt ?? null, binding: c.binding }, caps: c.caps, mode: st.mode };
}

// Ordre Polymarket. req = { token, cid, pocket, conviction, price, end?, expiresAt? } — price = meilleur ask
export function sizePm(portfolio, req, cfg = CONFIG, now = Date.now()) {
  const st = riskState(portfolio, cfg), r = cfg.risk, E = st.equity, pocket = req.pocket || "core", P = cfg.pockets;
  if (!req.token || !(req.price > 0 && req.price < 1)) return refuse("jeton ou prix invalide");
  const R = riskPerTrade(req.conviction, st.mode, cfg);
  if (!R) return refuse(st.mode === MODES.normal || st.mode === MODES.halveR ? `conviction ${req.conviction} < ${cfg.ai.minConviction}` : `mode ${st.mode} : aucune ouverture`);
  let c;
  if (pocket === "portage") {
    const pp = P.portage, days = req.end ? (Date.parse(req.end) - now) / DAY : Infinity;
    if (req.price < pp.minPrice || req.price > pp.maxPrice) return refuse(`portage : cote ${req.price} hors [${pp.minPrice}, ${pp.maxPrice}]`);
    if (!(days >= 0 && days <= pp.maxDays)) return refuse(`portage : échéance ${Number.isFinite(days) ? days.toFixed(1) + " j" : "inconnue"} > ${pp.maxDays} j`);
    c = capper(pp.maxStakeShare * E * (R / r.rMax), "mise portage")
      .cap(pp.maxStakeShare * E - (st.markets[req.cid] || 0), "plafond par marché");
  } else if (pocket === "border") {
    if (!req.expiresAt) return refuse("poche border : catalyseur daté (expiresAt) obligatoire");
    if (req.price > P.border.maxBuyPrice) return refuse(`poche border : prix ${req.price} > ${P.border.maxBuyPrice} (gain/risque < ${P.border.minRewardRisk})`);
    c = capper(P.border.perIdeaUsd * (R / r.rMax), "mise par idée border");
  } else c = capper(R * E, "risque R");
  c.cap(P[pocket].maxShare * E - (st.pockets[pocket] || 0), `poche ${pocket}`)
   .cap(r.maxGrossLeverage * E - st.gross, "levier brut global")
   .cap(portfolio.cash, "cash disponible");
  if (c.usd < r.minOrderUsd) return refuse(`mise ${c.usd.toFixed(2)} $ < minimum (limite : ${c.binding})`, { caps: c.caps });
  return { ok: true, order: { venue: "pm", token: String(req.token), cid: req.cid ?? null, pocket, usd: c.usd, R, riskUsd: c.usd,
    expiresAt: req.expiresAt ?? null, end: req.end ?? null, binding: c.binding }, caps: c.caps, mode: st.mode };
}

// Paire neutre (SPEC §3.3) : deux jambes de même notionnel, risque total R réparti sur les deux stops.
// legs = { long: { coin, price, atr }, short: { coin, price, atr } }
export function sizePair(portfolio, { long, short, conviction, pocket = "core" }, cfg = CONFIG) {
  const st = riskState(portfolio, cfg), r = cfg.risk, E = st.equity;
  if (!(long?.price > 0 && long?.atr > 0 && short?.price > 0 && short?.atr > 0)) return refuse("prix ou ATR manquant");
  if (long.coin === short.coin) return refuse("paire sur un seul actif");
  const R = riskPerTrade(conviction, st.mode, cfg);
  if (!R) return refuse(`mode ${st.mode} ou conviction insuffisante`);
  const a = hlStop(long.price, long.atr, "long", cfg), b = hlStop(short.price, short.atr, "short", cfg);
  // exposition nette par facteur après la paire
  const fa = factorOf(long.coin), fb = factorOf(short.coin), capF = r.factorCap * E;
  const c = capper((R * E) / (a.dStop + b.dStop), "risque R")
    .cap(r.perPositionEquityCap * E * r.maxPositionLeverage, "plafond par position")
    .cap((r.maxGrossLeverage * E - st.gross) / 2, "levier brut global")
    .cap((cfg.pockets[pocket].maxShare * E - (st.pockets[pocket] || 0)) * r.maxPositionLeverage / 2, `poche ${pocket}`);
  if (fa !== fb) {   // facteurs différents : chaque jambe pèse sur son facteur
    const room = (net, s) => (s * net >= 0 ? capF - Math.abs(net) : capF + Math.abs(net));
    c.cap(room(st.factors[fa] || 0, 1), `facteur ${fa}`).cap(room(st.factors[fb] || 0, -1), `facteur ${fb}`);
  }
  if (c.usd < r.minOrderUsd) return refuse(`taille ${c.usd.toFixed(2)} $ < minimum (limite : ${c.binding})`, { caps: c.caps });
  const leg = (x, side, s) => ({ venue: "hl", coin: x.coin, side, pocket, usd: c.usd, stopPx: s.stopPx, dStop: s.dStop, factor: factorOf(x.coin) });
  return { ok: true, orders: [leg(long, "long", a), leg(short, "short", b)], R, riskUsd: c.usd * (a.dStop + b.dStop), binding: c.binding, caps: c.caps, mode: st.mode };
}

// Sorties imposées par le mode : tout fermer en cas d'arrêt d'urgence.
export const killExits = (portfolio) => portfolio.positions.map((q) => ({ id: q.id, reason: "kill" }));
