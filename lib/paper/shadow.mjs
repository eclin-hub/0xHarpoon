// PnL contrefactuel par modèle (SPEC §4.2 point 4, §7) : « ce qu'aurait gagné chaque modèle seul ».
//
// Chaque vote OPEN valide ouvre une position fantôme pour son modèle, que le comité l'ait suivie ou non.
// Mesure en R (multiple du risque), indépendante des plafonds et de la taille réelle :
// - Hyperliquid : R = rendement dans le sens du trade / distance du stop (2 × ATR, borné 3 à 15 %) ;
//   paire : (rendement long − rendement short) / (somme des deux distances). Sortie à −1 R (stop) ou à l'horizon voté.
// - Polymarket : mise = risque, R = (prix de sortie − prix d'entrée) / prix d'entrée ; sortie à la résolution (1 $ ou 0 $),
//   ou à l'horizon voté au dernier prix connu.
// Un modèle qui vote OPEN plusieurs cycles de suite sur le même candidat n'ouvre qu'une position fantôme.
import { CONFIG } from "./config.mjs";
import { hlStop } from "./risk.mjs";
import { payoutOf } from "../pm.mjs";

const H = 3600e3;
const MAX_HORIZON_H = 720;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

export const emptyShadow = () => ({ open: [], closed: [] });

function legsOf(c, cfg) {
  const m = c.metrics || {};
  if (c.type === "pair") {
    const leg = (x, sign) => (x?.mark > 0 && x?.atr14 > 0 ? { coin: x.coin, sign, p0: x.mark, d: hlStop(x.mark, x.atr14, sign > 0 ? "long" : "short", cfg).dStop } : null);
    const ls = [leg(m.long_leg, 1), leg(m.short_leg, -1)];
    return ls.every(Boolean) ? ls : null;
  }
  if (c.venue === "hl") {
    const atr = m.atr14 ?? (m.atr_pct && m.mark ? m.atr_pct * m.mark : null);
    return m.mark > 0 && atr > 0 ? [{ coin: c.coin, sign: c.side === "long" ? 1 : -1, p0: m.mark, d: hlStop(m.mark, atr, c.side, cfg).dStop }] : null;
  }
  return null;
}

// votes : sortie annotée de decision.decide (champ `valid`, `model`, `action`, `candidate_id`, `horizon_hours`)
export function addShadows(book, votes, dossier, now = Date.now(), cfg = CONFIG) {
  const b = structuredClone(book || emptyShadow()), added = [];
  for (const v of votes) {
    if (!v.valid || v.action !== "OPEN") continue;
    const c = dossier.candidates.find((x) => x.id === v.candidate_id);
    if (!c || b.open.some((s) => s.model === v.model && s.candidateId === c.id)) continue;
    const base = { model: v.model, family: v.family, candidateId: c.id, conviction: v.conviction, openedAt: new Date(now).toISOString(),
      endsAt: new Date(now + Math.min(v.horizon_hours, MAX_HORIZON_H) * H).toISOString() };
    let s = null;
    if (c.venue === "pm") { if (c.metrics?.price > 0) s = { ...base, venue: "pm", token: c.token, cid: c.cid, outcome: c.outcome, p0: c.metrics.price }; }
    else { const legs = legsOf(c, cfg); if (legs) s = { ...base, venue: "hl", legs }; }
    if (s) { b.open.push(s); added.push(s); }
  }
  return { book: b, added };
}

// R courant d'une position fantôme Hyperliquid
export const hlR = (s, markets) => {
  if (!s.legs.every((l) => markets[l.coin]?.mark > 0)) return null;
  return s.legs.reduce((a, l) => a + l.sign * (markets[l.coin].mark / l.p0 - 1), 0) / s.legs.reduce((a, l) => a + l.d, 0);
};

// pmPrices : { "cid|outcome" → dernier prix connu } (positions des baleines du relevé)
export function updateShadows(book, { markets = {}, resolutions = {}, pmPrices = {} } = {}, now = Date.now()) {
  const b = structuredClone(book || emptyShadow()), closed = [];
  const finish = (s, R, why) => { const c = { ...s, closedAt: new Date(now).toISOString(), R: r4(R), exit: why }; b.closed.push(c); closed.push(c); };
  b.open = b.open.filter((s) => {
    const expired = now >= Date.parse(s.endsAt);
    if (s.venue === "hl") {
      const R = hlR(s, markets);
      if (R != null && R <= -1) { finish(s, -1, "stop"); return false; }
      if (expired && R != null) { finish(s, R, "horizon"); return false; }
      return true;
    }
    const pay = payoutOf(resolutions[s.cid], s.token);
    if (pay != null) { finish(s, (pay - s.p0) / s.p0, "résolution"); return false; }
    const px = pmPrices[`${s.cid}|${s.outcome}`];
    if (expired && px > 0) { finish(s, (px - s.p0) / s.p0, "horizon"); return false; }
    return true;
  });
  return { book: b, closed };
}

// Synthèse par modèle. usdPerR : valeur d'1 R en dollars (risque de référence : 1 % du capital de départ).
export function modelStats(book, markets = {}, usdPerR = CONFIG.startCapital * CONFIG.risk.rMin) {
  const out = {};
  const e = (m, fam) => (out[m] ??= { model: m, family: fam, open: 0, closed: 0, wins: 0, sumR: 0, openR: 0 });
  for (const s of book?.closed || []) { const x = e(s.model, s.family); x.closed++; x.sumR += s.R; if (s.R > 0) x.wins++; }
  for (const s of book?.open || []) { const x = e(s.model, s.family); x.open++; if (s.venue === "hl") x.openR += hlR(s, markets) ?? 0; }
  return Object.values(out).map((x) => ({ ...x, sumR: r4(x.sumR), openR: r4(x.openR), winRate: x.closed ? r4(x.wins / x.closed) : null,
    avgR: x.closed ? r4(x.sumR / x.closed) : null, pnlUsd: r4(x.sumR * usdPerR) })).sort((a, b) => b.sumR - a.sumR);
}
