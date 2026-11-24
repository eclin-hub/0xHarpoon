// Propositions de la poche Border (SPEC §1, §2) : thèses asymétriques avec catalyseur daté, écrites 3 à 4 fois par jour
// par une tâche Claude planifiée (recherche web) dans `border_proposals.json` de la branche `border`.
// Le moteur ne les exécute pas telles quelles : elles deviennent des candidats soumis au même vote que les autres,
// puis au moteur de risque (prix ≤ 0,25 sur Polymarket, gain/risque ≥ 3 sur Hyperliquid, 300 $ par idée, sans levier,
// clôture automatique à la date du catalyseur).
//
// Format :
// { "updatedAt": "<ISO>", "proposals": [ {
//     "id": "<unique>", "createdAt": "<ISO>", "venue": "pm" | "hl",
//     "thesis": "<20 à 1000 caractères>", "catalyst": "<événement>", "catalystAt": "<ISO, futur, ≤ 90 jours>",
//     "conviction": 0-100, "sources": ["https://…", …],
//     "pm": { "cid": "0x…", "token": "<token_id>", "outcome": "Yes", "title": "<question>" },     // si venue = pm
//     "hl": { "coin": "xyz:CL", "side": "long" | "short", "targetPx": 95.5 }                     // si venue = hl
// } ] }
import { CONFIG } from "./config.mjs";
import { hlStop } from "./risk.mjs";
import { categoryOfHl, categoryOfPm } from "./scorer.mjs";
import { factorOf } from "./config.mjs";

const DAY = 86400e3, H = 3600e3;
const MAX_AGE_H = 24, MAX_HORIZON_D = 90, MAX_PER_CYCLE = 2;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const isStr = (x, min = 1, max = 1000) => typeof x === "string" && x.trim().length >= min && x.length <= max;

export function validateProposal(p, now = Date.now()) {
  if (!p || typeof p !== "object") return { ok: false, error: "pas un objet" };
  if (!isStr(p.id, 1, 80)) return { ok: false, error: "id manquant" };
  const created = Date.parse(p.createdAt), at = Date.parse(p.catalystAt);
  if (!Number.isFinite(created) || created > now + 5 * 60e3) return { ok: false, error: "createdAt invalide" };
  if (!Number.isFinite(at) || at <= now || at > now + MAX_HORIZON_D * DAY) return { ok: false, error: "catalystAt passé ou à plus de 90 jours" };
  if (!isStr(p.thesis, 20, 1000) || !isStr(p.catalyst, 3, 300)) return { ok: false, error: "thèse ou catalyseur manquant" };
  if (!(typeof p.conviction === "number" && p.conviction >= 0 && p.conviction <= 100)) return { ok: false, error: "conviction hors de 0 – 100" };
  if (!Array.isArray(p.sources) || !p.sources.length || p.sources.length > 10 || !p.sources.every((s) => /^https?:\/\/\S+$/.test(s))) return { ok: false, error: "sources : 1 à 10 adresses http(s)" };
  if (p.venue === "pm") { if (!isStr(p.pm?.token) || !isStr(p.pm?.cid) || !isStr(p.pm?.outcome, 1, 60)) return { ok: false, error: "pm.token, pm.cid ou pm.outcome manquant" }; }
  else if (p.venue === "hl") { if (!isStr(p.hl?.coin, 1, 40) || !["long", "short"].includes(p.hl?.side) || !(p.hl?.targetPx > 0)) return { ok: false, error: "hl.coin, hl.side ou hl.targetPx invalide" }; }
  else return { ok: false, error: "venue pm ou hl attendue" };
  return { ok: true, value: p };
}

// Propositions encore à soumettre au vote : valides, récentes (< 24 h), pas encore votées. markets/ohlc/pmBooks du cycle.
export function borderCandidates(file, seen = [], { markets = {}, ohlc = {}, pmBooks = {} } = {}, now = Date.now(), cfg = CONFIG) {
  const out = [], rejected = [], done = new Set(seen);
  for (const p of file?.proposals || []) {
    const id = `border|${p?.id}`;
    if (done.has(p?.id)) continue;
    const v = validateProposal(p, now);
    if (!v.ok) { rejected.push({ id, reason: `proposition border : ${v.error}` }); continue; }
    if (now - Date.parse(p.createdAt) > MAX_AGE_H * H) { rejected.push({ id, reason: "proposition border de plus de 24 h" }); continue; }
    const days = (Date.parse(p.catalystAt) - now) / DAY;
    const base = { id, type: "border", pocket: "border", score: cfg.signals.leadLagScore, proposalId: p.id, expiresAt: p.catalystAt,
      thesis: p.thesis, catalyst: p.catalyst, sources: p.sources, proposerConviction: p.conviction };
    if (p.venue === "pm") {
      const ask = pmBooks[p.pm.token]?.asks?.[0]?.[0];
      if (!(ask > 0)) { rejected.push({ id, reason: "proposition border : carnet Polymarket indisponible" }); continue; }
      if (ask > cfg.pockets.border.maxBuyPrice) { rejected.push({ id, reason: `proposition border : prix ${ask} > ${cfg.pockets.border.maxBuyPrice}` }); continue; }
      out.push({ ...base, venue: "pm", cid: p.pm.cid, token: p.pm.token, outcome: p.pm.outcome, title: p.pm.title ?? null, category: categoryOfPm({ title: p.pm.title || "" }) ?? "geopolitics",
        metrics: { price: ask, implied_prob: ask, reward_risk: r4((1 - ask) / ask), days_to_catalyst: r4(days) } });
    } else {
      const mark = markets[p.hl.coin]?.mark, atr = ohlc[p.hl.coin]?.atr;
      if (!(mark > 0) || !(atr > 0)) { rejected.push({ id, reason: "proposition border : prix ou ATR manquant" }); continue; }
      const { dStop } = hlStop(mark, atr, p.hl.side, cfg), dir = p.hl.side === "long" ? 1 : -1, rr = (dir * (p.hl.targetPx - mark)) / (mark * dStop);
      if (rr < cfg.pockets.border.minRewardRisk) { rejected.push({ id, reason: `proposition border : gain/risque ${rr.toFixed(2)} < ${cfg.pockets.border.minRewardRisk}` }); continue; }
      out.push({ ...base, venue: "hl", coin: p.hl.coin, side: p.hl.side, targetPx: p.hl.targetPx, category: categoryOfHl(p.hl.coin), factor: factorOf(p.hl.coin),
        metrics: { mark: r4(mark), atr14: r4(atr), atr_pct: r4(atr / mark), target_px: p.hl.targetPx, stop_dist_pct: r4(dStop), reward_risk: r4(rr), days_to_catalyst: r4(days) } });
    }
    if (out.length >= MAX_PER_CYCLE) break;
  }
  return { candidates: out, rejected };
}

// Besoins réseau du cycle pour ces propositions (avant de construire les candidats)
export function borderNeeds(file, seen = []) {
  const ps = (file?.proposals || []).filter((p) => p && !seen.includes(p.id));
  return { tokens: ps.filter((p) => p.venue === "pm").map((p) => p.pm?.token).filter(Boolean), coins: ps.filter((p) => p.venue === "hl").map((p) => p.hl?.coin).filter(Boolean) };
}

export const markSeen = (seen = [], ids = []) => [...new Set([...seen, ...ids])].slice(-200);
