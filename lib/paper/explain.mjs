// Explications en français simple des ouvertures et des fermetures (colonne « Avis / Raison » de Paper trading).
//   Décisions du panel (vote) : qui a voté quoi, avec quel poids, et la synthèse de leurs raisons en une phrase.
//   Sorties automatiques (stop, échéance, résolution Polymarket, arrêt d'urgence) : une phrase factuelle chiffrée.
// Les paramètres techniques cités par les modèles (dist_atr = 0.55…) sont traduits en mots.

const pct = (x, d = 1) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(d).replace(".", ",")} %`;
const r1 = (x) => Math.round(x * 1000) / 10;

// clés de métriques du dossier → libellé lisible
const METRIC_WORDS = [
  [/\bdist_atr\b/g, "écart au prix des baleines (en ATR)"], [/\batr_pct\b/g, "volatilité horaire (ATR)"], [/\bdist_to_stop_pct\b/g, "distance au stop"],
  [/\bpnl_pct\b/g, "gain latent"], [/\bpm_price_start\b/g, "cote Polymarket de départ"], [/\bpm_price\b/g, "cote Polymarket"], [/\bpm_move\b/g, "mouvement de la cote"],
  [/\basset_move\b/g, "mouvement du sous-jacent"], [/\breaction_needed\b/g, "réaction attendue du prix"], [/\bwindow_min\b/g, "fenêtre (min)"],
  [/\bfunding_paid_usd\b/g, "funding payé"], [/\bfunding(_ann)?\b/g, "funding"], [/\bmark\b/g, "prix"], [/\bentry\b/g, "entrée"], [/\bstop\b/g, "stop"],
  [/\bx_bias\b/g, "biais X"], [/\bx_velocity\b/g, "vélocité X"], [/\bmentionVelocityRatio\b/g, "vélocité des mentions X"], [/\bnetNarrativeBias\b/g, "biais du récit X"],
  [/\bsqueezeWarning\b/g, "alerte de squeeze"], [/\bscore\b/g, "score"], [/\bwhales?\b/g, "baleines"],
];
export function humanize(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  for (const [re, w] of METRIC_WORDS) s = s.replace(re, w);
  return s;
}
const short = (s, n = 70) => { const t = humanize(s); return t.length > n ? t.slice(0, n - 1).replace(/[\s,;:.]+\S*$/, "") + "…" : t; };

// Raison courte d'un vote : champ `reason` s'il existe, sinon la condition d'invalidation (CLOSE) ou la métrique citée
export const voteReason = (v) => v.reason || (v.action === "CLOSE" || v.action === "OPEN" ? v.invalidation_condition : v.cited_risk_metric) || "";

// Détail des votes décisionnels (poids > 0) sur un candidat ou une position :
// → { n, total, share, yes: [{ model, weight, conviction, reason }], no: [...] } ; yes = votes `action`
export function voteDetail(votes, id, action) {
  const vs = (votes || []).filter((v) => v.candidate_id === id && v.valid !== false && v.weight !== 0);
  const W = (v) => (typeof v.weight === "number" ? v.weight : 1), tot = vs.reduce((a, v) => a + W(v), 0);
  const row = (v) => ({ model: v.model, action: v.action, weight: Math.round(W(v) * 1e4) / 1e4, conviction: v.conviction ?? null, reason: short(voteReason(v), 160) });
  const yes = vs.filter((v) => v.action === action).sort((a, b) => W(b) - W(a)), no = vs.filter((v) => v.action !== action).sort((a, b) => W(b) - W(a));
  return { n: vs.length, total: tot, share: tot > 0 ? yes.reduce((a, v) => a + W(v), 0) / tot : 0, yes: yes.map(row), no: no.map(row) };
}

// Synthèse des raisons des votants majoritaires (les 2 plus lourds, dédoublonnées)
const synth = (rows) => [...new Set(rows.map((r) => short(r.reason, 70)).filter(Boolean))].slice(0, 2).join(" ; ");

export function explainClose(detail) {
  if (!detail || !detail.n) return "Clôturé par vote du panel";
  const why = synth(detail.yes);
  return `Clôturé par ${detail.yes.length}/${detail.n} modèle${detail.n > 1 ? "s" : ""} (${Math.round(detail.share * 100)} % du poids)${why ? ` : ${why}` : ""}`;
}

export function explainOpen(detail, { via = "", arbiter = null } = {}) {
  if (arbiter) return `Ouvert par l'arbitre ${arbiter.model} (votes partagés ${detail?.yes?.length ?? "?"}/${detail?.n ?? "?"})${arbiter.reason ? ` : ${short(arbiter.reason, 110)}` : ""}`;
  if (!detail || !detail.n) return `Ouvert${via ? ` (${via})` : ""}`;
  const why = synth(detail.yes);
  return `Ouvert par ${detail.yes.length}/${detail.n} modèle${detail.n > 1 ? "s" : ""} (${Math.round(detail.share * 100)} % du poids)${why ? ` : ${why}` : ""}`;
}

// Rendement d'une position fermée, dans son sens (HL : prix ; PM : cote)
export function tradeReturn(t) {
  if (!(t.entryPx > 0) || !(t.px >= 0)) return null;
  return t.venue === "pm" ? t.px / t.entryPx - 1 : (t.side === "short" ? -1 : 1) * (t.px / t.entryPx - 1);
}

// Phrase d'une sortie automatique ou par vote (trade de type close / reduce / settle)
export function explainExit(t) {
  if (t.explain) return t.explain;
  const r = tradeReturn(t), rTxt = r == null ? "" : ` à ${pct(r)}`;
  switch (t.type === "settle" ? "settle" : t.reason) {
    case "stop": {
      const d = t.stopPx > 0 && t.entryPx > 0 ? Math.abs(t.stopPx / t.entryPx - 1) : null;
      return `Stop-Loss automatique touché${rTxt}${d != null ? ` (stop placé à ${r1(d).toString().replace(".", ",")} % de l'entrée, 2 × ATR)` : " (2 × ATR)"}`;
    }
    case "tp": case "take_profit": return `Take-Profit automatique atteint${rTxt}`;
    case "trailing": return `Trailing stop déclenché${rTxt}`;
    case "expiry": return `Échéance atteinte (horizon voté ou date du catalyseur)${rTxt}`;
    case "kill": return `Arrêt d'urgence : drawdown du portefeuille au seuil maximal, tout est fermé${rTxt}`;
    case "settle": return `Marché Polymarket résolu : ${t.won === true ? "pari gagné (1 $ par part)" : t.won === false ? "pari perdu (0 $ par part)" : "réglé"}${rTxt}`;
    case "vote": return `Clôturé par vote du panel${rTxt}`;
    case "signal inverse": return `Clôturé par un signal opposé validé${rTxt}`;
    case "reduceOnly": case "mode": return `Réduction imposée par le frein de drawdown${rTxt}`;
    default: return t.type === "reduce" ? `Réduction partielle${rTxt}` : `Fermé (${t.reason || "manuel"})${rTxt}`;
  }
}

// Ajoute `explain` aux trades du cycle qui n'en ont pas (sorties automatiques) ; les ouvertures gardent le leur.
export const withExplain = (t) => (t.explain || t.type === "open" || t.type === "mode" ? t : { ...t, explain: explainExit(t) });
