// Exécution des décisions : le moteur de risque fixe la taille, le simulateur remplit sur le carnet réel du moment.
// Les ordres sont traités un par un : chaque ouverture modifie le portefeuille, donc les plafonds de la suivante.
import { CONFIG } from "./config.mjs";
import { sizeHl, sizePm, sizePair, voteCloseCheck, reentryCheck, correlatedCheck, barrierCheck, exitKey } from "./risk.mjs";
import { openHl, closeHl, openPm, closePm } from "./simulator.mjs";

const H = 3600e3;

// deps : { fetchL2Book(coin), fetchBook(token) } (lib/hl.mjs, lib/pm.mjs) — injectables pour les tests
// exits : { clé (risk.exitKey) → date ISO de la dernière fermeture complète }, pour le délai de ré-entrée.
// Garde-fous (config.guards) : pas de sortie par vote avant 8 h, pas de ré-entrée moins de 4 h après une fermeture,
// au plus 3 positions du panier corrélé dans le même sens, pas de signal Polymarket à barrière trop éloignée du prix.
export async function executeDecisions(portfolio, decisions, dossier, { markets = {}, deps, now = Date.now(), exits = {} } = {}, cfg = CONFIG) {
  let p = portfolio;
  const ex = { ...exits };
  const trades = [], refused = [], book = async (kind, k) => { try { return await (kind === "hl" ? deps.fetchL2Book(k) : deps.fetchBook(k)); } catch (e) { return { error: String(e.message || e) }; } };
  // explain / votes : phrase et détail des votes de la décision (ouverture ou fermeture par le panel), gardés sur le trade
  // et, à l'ouverture, sur la position (colonne « Avis / Raison »)
  const done = (r, d) => { if (r.rejected) { refused.push({ id: d.id, reason: r.rejected.reason }); return false; } p = r.portfolio;
    const why = d.explain ? { explain: d.explain, votes: d.votes ?? null } : {};
    trades.push({ ...r.trade, decision: d.via, ...why });
    if (r.trade.type === "open" && d.explain) p = { ...p, positions: p.positions.map((q) => (q.id === r.trade.id ? { ...q, openExplain: d.explain, openVotes: d.votes ?? null } : q)) };
    if (r.trade.type === "close") ex[exitKey(r.trade)] = r.trade.at;
    return true; };
  const guard = (g, d) => { if (g.ok) return true; refused.push({ id: d.id, reason: g.reason }); return false; };

  // fermetures d'abord : elles libèrent de la place sous les plafonds
  for (const d of decisions.filter((x) => x.action === "CLOSE")) {
    const q = p.positions.find((x) => x.id === d.id);
    if (!q || !guard(voteCloseCheck(q, d, now, cfg), d)) continue;
    const b = await book(q.venue, q.venue === "hl" ? q.coin : q.token);
    done(q.venue === "hl" ? closeHl(p, q.id, b, { reason: "vote", markPx: markets[q.coin]?.mark }, now, cfg) : closePm(p, q.id, b, { reason: "vote" }, now, cfg), d);
  }

  for (const d of decisions.filter((x) => x.action === "OPEN")) {
    const c = dossier.candidates.find((x) => x.id === d.id), m = c?.metrics || {};
    if (!c) { refused.push({ id: d.id, reason: "candidat absent du dossier" }); continue; }
    const legs = c.type === "pair" ? [{ coin: m.long_leg?.coin, side: "long" }, { coin: m.short_leg?.coin, side: "short" }] : c.venue === "hl" ? [{ coin: c.coin, side: c.side }] : [];
    if (!guard(reentryCheck(c.venue === "pm" ? [exitKey(c)] : legs.map((l) => exitKey({ venue: "hl", coin: l.coin })), ex, now, cfg), d)) continue;
    if (legs.length && !guard(correlatedCheck(p, legs, cfg), d)) continue;
    if (c.type === "leadlag" && !guard(barrierCheck(m.pm_title ?? c.pm?.title, markets[c.coin]?.mark ?? m.mark, cfg), d)) continue;
    const meta = { candidateId: c.id, conviction: d.conviction ?? null, invalidation: d.invalidation, horizonH: d.horizonH, expiresAt: c.expiresAt ?? (c.pocket === "border" && d.horizonH ? new Date(now + d.horizonH * H).toISOString() : null) };   // border : date du catalyseur
    if (c.venue === "hl" && c.type !== "pair") {
      const atr = m.atr14 ?? (m.atr_pct && m.mark ? m.atr_pct * m.mark : null);
      const s = sizeHl(p, { coin: c.coin, side: c.side, pocket: c.pocket, conviction: d.conviction, price: markets[c.coin]?.mark ?? m.mark, atr, expiresAt: meta.expiresAt, targetPx: c.targetPx ?? d.targetPx }, cfg);
      if (!s.ok) { refused.push({ id: c.id, reason: s.reason }); continue; }
      done(openHl(p, { ...meta, ...s.order }, await book("hl", c.coin), now, cfg), d);
    } else if (c.type === "pair") {
      const leg = (x) => ({ coin: x.coin, price: markets[x.coin]?.mark ?? x.mark, atr: x.atr14 });
      const s = sizePair(p, { long: leg(m.long_leg), short: leg(m.short_leg), conviction: d.conviction, pocket: c.pocket }, cfg);
      if (!s.ok) { refused.push({ id: c.id, reason: s.reason }); continue; }
      const [bl, bs] = [await book("hl", s.orders[0].coin), await book("hl", s.orders[1].coin)];
      if (!bl?.asks?.length || !bs?.bids?.length) { refused.push({ id: c.id, reason: "carnet indisponible pour une jambe" }); continue; }
      if (done(openHl(p, { ...meta, ...s.orders[0] }, bl, now, cfg), d)) {
        if (!done(openHl(p, { ...meta, ...s.orders[1] }, bs, now, cfg), d)) {   // une jambe seule n'est pas une paire : on referme
          const first = p.positions.at(-1);
          done(closeHl(p, first.id, bl, { reason: "jambe orpheline", forced: true, markPx: markets[first.coin]?.mark }, now, cfg), d);
        }
      }
    } else {
      const b = await book("pm", c.token), ask = b?.asks?.[0]?.[0];
      if (!ask) { refused.push({ id: c.id, reason: b?.error ? `carnet : ${b.error}` : "aucun vendeur" }); continue; }
      const s = sizePm(p, { token: c.token, cid: c.cid, pocket: c.pocket, conviction: d.conviction, price: ask, end: m.end ?? null, expiresAt: meta.expiresAt }, cfg, now);
      if (!s.ok) { refused.push({ id: c.id, reason: s.reason }); continue; }
      done(openPm(p, { ...meta, ...s.order, outcome: c.outcome, title: c.title }, b, now, cfg), d);
    }
  }
  return { portfolio: p, trades, refused };
}
