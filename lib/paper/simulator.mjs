// Exécution simulée et comptabilité (SPEC §6).
// Toutes les fonctions sont pures : elles reçoivent un portefeuille et renvoient une copie modifiée, plus le journal.
// Les décisions (ouvrir, fermer, combien) viennent d'ailleurs : ce module ne fait qu'exécuter et compter.
//
// Comptabilité :
// - Hyperliquid (perps) : le notionnel n'immobilise pas de cash. cash -= frais à l'ouverture ; cash += PnL réalisé − frais
//   à la fermeture ; cash -= funding chaque heure. Valeur = PnL latent au prix mark.
// - Polymarket : cash -= coût d'achat des parts ; cash += produit de la vente, ou 1 $ / 0 $ par part à la résolution.
//   Valeur = parts × milieu du carnet.
// - equity = cash + Σ PnL latent HL + Σ valeur PM.
import { CONFIG, factorOf } from "./config.mjs";
import { payoutOf } from "../pm.mjs";
import { nextMode, killExits, MODES } from "./risk.mjs";

const EPS = 1e-9;
const sgn = (side) => (side === "long" ? 1 : -1);
const hourIndex = (ms) => Math.floor(ms / 3600e3);
const iso = (ms) => new Date(ms).toISOString();
const round = (x, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

// Parcourt un côté du carnet ([[px, sz]…], meilleur prix en tête) jusqu'à la quantité ou au montant voulu.
// dir "buy" : on consomme des asks (prix croissants) ; "sell" : des bids (prix décroissants).
// limitPx : on s'arrête avant un niveau plus mauvais (null = sans limite).
export function walkBook(levels, { qty = Infinity, usd = Infinity }, limitPx = null, dir = "buy") {
  let q = 0, cost = 0, used = 0, lastPx = null;
  for (const [px, sz] of levels || []) {
    if (limitPx != null && (dir === "buy" ? px > limitPx + EPS : px < limitPx - EPS)) break;
    const take = Math.min(sz, qty - q, (usd - cost) / px);
    if (!(take > 0)) break;
    q += take; cost += take * px; used++; lastPx = px;
    if (q >= qty - EPS || cost >= usd - EPS) break;
  }
  const best = levels?.[0]?.[0] ?? null;
  return { qty: q, usd: cost, avgPx: q ? cost / q : null, best, lastPx, levels: used, slippage: q && best ? Math.abs(cost / q - best) : 0 };
}

const hlLimit = (best, dir, s) => (best == null ? null : dir === "buy" ? best * (1 + s) : best * (1 - s));
const pmLimit = (best, dir, s) => (best == null ? null : dir === "buy" ? best + s : best - s);
const nextId = (p, venue) => { p.seq = (p.seq || 0) + 1; return `${venue}-${p.seq}`; };
const reject = (portfolio, reason, req) => ({ portfolio, trade: null, rejected: { reason, req } });

/* ---------------- Hyperliquid ---------------- */

export function openHl(portfolio, req, book, now = Date.now(), cfg = CONFIG) {
  const { coin, side, usd, stopPx = null, pocket = "core" } = req;
  if (!(usd > 0) || (side !== "long" && side !== "short")) return reject(portfolio, "ordre invalide", req);
  const dir = side === "long" ? "buy" : "sell", levels = dir === "buy" ? book?.asks : book?.bids;
  if (!levels?.length) return reject(portfolio, "carnet vide", req);
  const fill = walkBook(levels, { usd }, hlLimit(levels[0][0], dir, cfg.exec.hlMaxSlippage), dir);
  if (fill.usd < cfg.exec.minFillShare * usd) return reject(portfolio, `liquidité insuffisante (${round(fill.usd, 2)} $ sur ${usd} $)`, req);
  const p = structuredClone(portfolio), fee = fill.usd * cfg.exec.hlTakerFee, id = nextId(p, "hl");
  p.cash -= fee;
  const pos = {
    id, venue: "hl", pocket, coin, side, factor: factorOf(coin), size: fill.qty, entryPx: fill.avgPx, entryUsd: fill.usd,
    stopPx, entryFee: fee, fees: fee, funding: 0, realized: 0, mark: fill.avgPx, upnl: 0,
    openedAt: iso(now), lastFundingAt: iso(now), expiresAt: req.expiresAt ?? null,
    candidateId: req.candidateId ?? null, conviction: req.conviction ?? null, invalidation: req.invalidation ?? null, horizonH: req.horizonH ?? null,
  };
  p.positions.push(pos);
  const trade = { at: iso(now), type: "open", id, venue: "hl", pocket, coin, side, qty: fill.qty, px: fill.avgPx, usd: fill.usd,
    fee, slippage: fill.slippage, requestedUsd: usd, partial: fill.usd < usd - 0.01, candidateId: pos.candidateId, conviction: pos.conviction };
  return { portfolio: p, trade, rejected: null };
}

// forced = sortie obligatoire (stop, échéance, arrêt d'urgence) : pas de limite de glissement ; si le carnet ne suffit pas,
// le reste est compté au dernier prix (ou au mark) dégradé de hlMaxSlippage. Sinon, fermeture partielle possible.
export function closeHl(portfolio, id, book, { reason = "manual", forced = false, markPx = null } = {}, now = Date.now(), cfg = CONFIG) {
  const pos = portfolio.positions.find((x) => x.id === id && x.venue === "hl");
  if (!pos) return reject(portfolio, `position ${id} introuvable`, { id });
  const dir = pos.side === "long" ? "sell" : "buy", levels = (dir === "sell" ? book?.bids : book?.asks) || [];
  const fill = walkBook(levels, { qty: pos.size }, forced ? null : hlLimit(levels[0]?.[0] ?? null, dir, cfg.exec.hlMaxSlippage), dir);
  let qty = fill.qty, usd = fill.usd, synthetic = 0;
  if (forced && qty < pos.size - EPS) {
    const base = fill.lastPx ?? markPx ?? pos.mark;
    if (!(base > 0)) return reject(portfolio, `aucun prix pour fermer ${pos.coin}`, { id });
    const px = dir === "sell" ? base * (1 - cfg.exec.hlMaxSlippage) : base * (1 + cfg.exec.hlMaxSlippage);
    synthetic = pos.size - qty; usd += synthetic * px; qty = pos.size;
  }
  if (!(qty > EPS)) return reject(portfolio, `carnet vide pour ${pos.coin}`, { id });
  const p = structuredClone(portfolio), q = p.positions.find((x) => x.id === id);
  const avg = usd / qty, fee = usd * cfg.exec.hlTakerFee, gross = sgn(q.side) * qty * (avg - q.entryPx);
  p.cash += gross - fee;
  q.realized += gross - fee; q.fees += fee; q.size -= qty;
  const full = q.size <= EPS;
  if (full) p.positions = p.positions.filter((x) => x.id !== id);
  const trade = { at: iso(now), type: full ? "close" : "reduce", id, venue: "hl", pocket: q.pocket, coin: q.coin, side: q.side, reason,
    qty, px: avg, usd, fee, pnl: gross - fee, synthetic, candidateId: q.candidateId, conviction: q.conviction,
    ...(full ? { net: q.realized - q.entryFee + q.funding, fees: q.fees, funding: q.funding, openedAt: q.openedAt, entryPx: q.entryPx } : {}) };
  return { portfolio: p, trade, rejected: null };
}

// Funding horaire : payé (ou reçu) une fois par heure pleine franchie depuis le dernier paiement, au taux courant.
// Taux positif : les longs paient les shorts. Approximation assumée : le taux du moment vaut pour toutes les heures manquées.
export function applyFunding(portfolio, markets, now = Date.now()) {
  const p = structuredClone(portfolio), payments = [];
  for (const q of p.positions) {
    if (q.venue !== "hl") continue;
    const m = markets?.[q.coin], hours = hourIndex(now) - hourIndex(Date.parse(q.lastFundingAt));
    if (!m || !(m.mark > 0) || hours <= 0) continue;
    const pay = sgn(q.side) * q.size * m.mark * (m.funding || 0) * hours;
    p.cash -= pay; q.funding -= pay; q.lastFundingAt = iso(now);
    payments.push({ id: q.id, coin: q.coin, hours, rate: m.funding || 0, paid: pay });
  }
  return { portfolio: p, payments };
}

/* ---------------- Polymarket ---------------- */

export function openPm(portfolio, req, book, now = Date.now(), cfg = CONFIG) {
  const { token, cid, usd, pocket = "core" } = req;
  if (!token || !(usd > 0)) return reject(portfolio, "ordre invalide", req);
  if (usd > portfolio.cash + EPS) return reject(portfolio, `cash insuffisant (${round(portfolio.cash, 2)} $)`, req);
  const levels = book?.asks;
  if (!levels?.length) return reject(portfolio, "carnet vide", req);
  const fill = walkBook(levels, { usd }, pmLimit(levels[0][0], "buy", cfg.exec.pmMaxSlippage), "buy");
  if (fill.usd < cfg.exec.minFillShare * usd) return reject(portfolio, `liquidité insuffisante (${round(fill.usd, 2)} $ sur ${usd} $)`, req);
  const p = structuredClone(portfolio), id = nextId(p, "pm");
  p.cash -= fill.usd;
  const pos = {
    id, venue: "pm", pocket, token: String(token), cid: cid ?? null, outcome: req.outcome ?? null, title: req.title ?? null,
    shares: fill.qty, entryPx: fill.avgPx, cost: fill.usd, realized: 0, mark: fill.avgPx, value: fill.usd,
    openedAt: iso(now), expiresAt: req.expiresAt ?? null, end: req.end ?? null,
    candidateId: req.candidateId ?? null, conviction: req.conviction ?? null, invalidation: req.invalidation ?? null, horizonH: req.horizonH ?? null,
  };
  p.positions.push(pos);
  const trade = { at: iso(now), type: "open", id, venue: "pm", pocket, token: pos.token, cid: pos.cid, outcome: pos.outcome, title: pos.title,
    qty: fill.qty, px: fill.avgPx, usd: fill.usd, fee: 0, slippage: fill.slippage, requestedUsd: usd, partial: fill.usd < usd - 0.01, candidateId: pos.candidateId, conviction: pos.conviction };
  return { portfolio: p, trade, rejected: null };
}

// Vente des parts sur les bids. Ce qui ne trouve pas preneur reste en portefeuille (fermeture partielle), même si forcée :
// sur Polymarket, on ne peut pas inventer d'acheteur, et la part garde sa valeur de résolution.
export function closePm(portfolio, id, book, { reason = "manual", forced = false } = {}, now = Date.now(), cfg = CONFIG) {
  const pos = portfolio.positions.find((x) => x.id === id && x.venue === "pm");
  if (!pos) return reject(portfolio, `position ${id} introuvable`, { id });
  const levels = book?.bids || [];
  const fill = walkBook(levels, { qty: pos.shares }, forced ? null : pmLimit(levels[0]?.[0] ?? null, "sell", cfg.exec.pmMaxSlippage), "sell");
  if (!(fill.qty > EPS)) return reject(portfolio, "aucun acheteur dans le carnet", { id });
  const p = structuredClone(portfolio), q = p.positions.find((x) => x.id === id);
  const costShare = q.cost * (fill.qty / q.shares), pnl = fill.usd - costShare;
  p.cash += fill.usd;
  q.realized += pnl; q.cost -= costShare; q.shares -= fill.qty;
  const full = q.shares <= EPS;
  if (full) p.positions = p.positions.filter((x) => x.id !== id);
  const trade = { at: iso(now), type: full ? "close" : "reduce", id, venue: "pm", pocket: q.pocket, token: q.token, cid: q.cid, outcome: q.outcome, title: q.title,
    reason, qty: fill.qty, px: fill.avgPx, usd: fill.usd, fee: 0, pnl, candidateId: q.candidateId, conviction: q.conviction, ...(full ? { net: q.realized, entryPx: q.entryPx, openedAt: q.openedAt } : {}) };
  return { portfolio: p, trade, rejected: null };
}

// Résolution : 1 $ par part gagnante, 0 $ sinon. Rien à faire si le marché n'est pas encore tranché.
export function settlePm(portfolio, id, resolution, now = Date.now()) {
  const pos = portfolio.positions.find((x) => x.id === id && x.venue === "pm");
  const pay = payoutOf(resolution, pos?.token);
  if (!pos || pay == null) return { portfolio, trade: null };
  const p = structuredClone(portfolio), q = p.positions.find((x) => x.id === id), proceeds = q.shares * pay, pnl = proceeds - q.cost;
  p.cash += proceeds;
  p.positions = p.positions.filter((x) => x.id !== id);
  return { portfolio: p, trade: { at: iso(now), type: "settle", id, venue: "pm", pocket: q.pocket, token: q.token, cid: q.cid, outcome: q.outcome, title: q.title,
    qty: q.shares, px: pay, usd: proceeds, fee: 0, pnl, net: q.realized + pnl, won: pay === 1, entryPx: q.entryPx, openedAt: q.openedAt, candidateId: q.candidateId, conviction: q.conviction } };
}

/* ---------------- valorisation et sorties ---------------- */

export const mid = (book) => {
  const b = book?.bids?.[0]?.[0], a = book?.asks?.[0]?.[0];
  return b && a ? (a + b) / 2 : b || a || null;
};

export function markToMarket(portfolio, { markets = {}, pmBooks = {} } = {}, now = Date.now()) {
  const p = structuredClone(portfolio);
  let hlUpnl = 0, pmValue = 0, gross = 0;
  for (const q of p.positions) {
    if (q.venue === "hl") {
      const m = markets[q.coin]?.mark;
      if (m > 0) q.mark = m;
      q.upnl = sgn(q.side) * q.size * (q.mark - q.entryPx);
      hlUpnl += q.upnl; gross += q.size * q.mark;
    } else {
      const m = mid(pmBooks[q.token]);
      if (m > 0) q.mark = m;
      q.value = q.shares * q.mark;
      pmValue += q.value; gross += q.value;
    }
  }
  p.equity = p.cash + hlUpnl + pmValue;
  p.peakEquity = Math.max(p.peakEquity ?? p.equity, p.equity);
  p.drawdown = p.peakEquity > 0 ? 1 - p.equity / p.peakEquity : 0;
  p.grossExposure = gross;
  p.markedAt = iso(now);
  const point = { at: iso(now), equity: round(p.equity, 2), cash: round(p.cash, 2), hlUpnl: round(hlUpnl, 2), pmValue: round(pmValue, 2),
    gross: round(gross, 2), drawdown: round(p.drawdown, 5), positions: p.positions.length };
  return { portfolio: p, point };
}

// Sorties obligatoires : stop touché (au prix mark) ou échéance dépassée (catalyseur de la poche border, horizon).
export function dueExits(portfolio, markets = {}, now = Date.now()) {
  const out = [];
  for (const q of portfolio.positions) {
    if (q.expiresAt && now >= Date.parse(q.expiresAt)) { out.push({ id: q.id, reason: "expiry" }); continue; }
    if (q.venue !== "hl" || q.stopPx == null) continue;
    const m = markets[q.coin]?.mark;
    if (m > 0 && (q.side === "long" ? m <= q.stopPx : m >= q.stopPx)) out.push({ id: q.id, reason: "stop", mark: m });
  }
  return out;
}

// Exécute une liste de sorties forcées ; celles qui échouent (carnet absent…) sont signalées et retentées au cycle suivant.
function runExits(p, exits, { markets, hlBooks, pmBooks }, now, cfg, trades, problems) {
  for (const ex of exits) {
    const q = p.positions.find((x) => x.id === ex.id);
    if (!q) continue;
    const r = q.venue === "hl"
      ? closeHl(p, q.id, hlBooks[q.coin], { reason: ex.reason, forced: true, markPx: markets[q.coin]?.mark ?? null }, now, cfg)
      : closePm(p, q.id, pmBooks[q.token], { reason: ex.reason, forced: true }, now, cfg);
    if (r.rejected) { problems.push(`${ex.reason} ${q.id} non exécuté : ${r.rejected.reason}`); continue; }
    p = r.portfolio; trades.push(r.trade);
  }
  return p;
}

// Cycle comptable d'une heure : résolutions, funding, sorties obligatoires, valorisation, puis freins de drawdown (SPEC §5.2).
// Si le drawdown atteint le seuil d'arrêt d'urgence, toutes les positions sont fermées dans le même cycle.
export function tick(portfolio, { markets = {}, hlBooks = {}, pmBooks = {}, resolutions = {} } = {}, now = Date.now(), cfg = CONFIG) {
  let p = portfolio;
  const trades = [], problems = [], data = { markets, hlBooks, pmBooks };
  for (const q of portfolio.positions.filter((x) => x.venue === "pm")) {
    const r = settlePm(p, q.id, resolutions[q.cid], now);
    p = r.portfolio; if (r.trade) trades.push(r.trade);
  }
  const f = applyFunding(p, markets, now);
  p = runExits(f.portfolio, dueExits(f.portfolio, markets, now), data, now, cfg, trades, problems);
  let m = markToMarket(p, { markets, pmBooks }, now);
  const from = portfolio.mode || MODES.normal, to = nextMode(from, m.portfolio.drawdown, cfg);
  p = { ...m.portfolio, mode: to };
  const modeChange = from !== to ? { at: iso(now), type: "mode", from, to, drawdown: m.portfolio.drawdown, equity: m.portfolio.equity } : null;
  if (modeChange) trades.push(modeChange);
  if (to === MODES.killed && p.positions.length) {
    p = runExits(p, killExits(p), data, now, cfg, trades, problems);
    m = markToMarket(p, { markets, pmBooks }, now);
    p = { ...m.portfolio, mode: to };
  }
  return { portfolio: p, trades, funding: f.payments, point: { ...m.point, mode: to }, problems, modeChange };
}
