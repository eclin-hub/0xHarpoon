"use strict";
/* Agent de paper trading (SPEC.md) : capital, courbe contre BTC et 50/50 BTC-or, positions, candidats, votes des modèles,
   PnL contrefactuel par modèle, historique. Les fichiers viennent de data/paper (serveur local : /api/paper/…,
   GitHub Pages : paper/…, recopiés à chaque collecte). Lecture seule : la page n'agit jamais sur l'agent. */
App.views.paper = (() => {
  const z = {}, D = { at: 0, err: null };
  const base = () => (App.PAGES ? "paper/" : App.SNAP ? null : "/api/paper/");
  const MODE = { normal: ["normal", "up"], halveR: ["risque ÷ 2", "cyan"], reduceOnly: ["plus d'ouverture", "down"], killed: ["arrêt d'urgence", "down"] };
  const POCKET = { core: "cœur", portage: "portage", border: "border" };
  const money = (x, d = 2) => "$" + x.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });   // montant exact : $10 k masquerait les petites variations
  const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
  const pctOr = (x, d = 1) => (x == null || !Number.isFinite(x) ? "—" : pct(x, d));
  const when = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  // Marchés Polymarket : intitulé lisible (lien vers Polymarket, échéance), le conditionId 0x… seulement en info-bulle
  // et en sous-texte discret. Les lignes écrites avant l'enregistrement des intitulés passent par pm_markets.json.
  const cidOf = (x) => String((typeof x === "string" ? x : x && (x.cid || x.pm?.cid || x.candidateId || x.candidate_id || x.id)) || "").match(/0x[0-9a-f]{64}/i)?.[0]?.toLowerCase() || null;
  const shortCid = (c) => c.slice(0, 6) + "…" + c.slice(-4);
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : null);
  function pmOf(x) {
    const cid = cidOf(x); if (!cid) return null;
    const own = x.venue === "pm" ? x : x.pm || {}, c = D.pm?.[cid] || {}, id = String(x.candidateId || x.candidate_id || x.id || "");
    return { cid, outcome: own.outcome ?? x.outcome ?? x.metrics?.pm_outcome ?? (id.split("|")[2] || null), title: own.title || x.metrics?.pm_title || c.title || null,
      endDate: own.endDate || own.end || c.endDate || null, url: own.url || c.url || null,
      entryOdds: x.pm?.entryOdds ?? x.metrics?.pm_price ?? null, odds: x.pm?.odds ?? null };
  }
  function pmLabel(i, { lead = null } = {}) {
    const t = i.title || shortCid(i.cid), name = i.url ? h("a", { href: i.url, target: "_blank", rel: "noopener noreferrer", title: i.cid, style: "color:inherit" }, t) : h("span", { title: i.cid }, t);
    return h("span", { style: "display:inline-block;min-width:240px;max-width:360px;white-space:normal" }, lead, lead ? h("span", { class: "muted" }, " · signal ") : null, i.title ? name : h("span", { class: "mono" }, name),
      i.outcome ? h("span", { class: "chip neutral", style: "margin-left:6px" }, i.outcome) : null,
      lead && (i.entryOdds != null || i.odds != null) ? h("div", { style: "font-size:.75rem;font-weight:400", title: "Cote du pari Polymarket (probabilité implicite) : simple signal, aucune part Polymarket n'est achetée" },
        h("span", { class: "muted" }, "cote du signal "), h("span", { class: "mono" }, odd(i.entryOdds)), i.odds != null && i.entryOdds != null ? [h("span", { class: "muted" }, " → "), h("span", { class: "mono " + cls(i.odds - i.entryOdds) }, odd(i.odds))] : null,
        h("span", { class: "muted" }, i.entryOdds != null && i.odds != null ? " (entrée → maintenant)" : i.entryOdds != null ? " à l'entrée" : " maintenant")) : null,
      h("div", { class: "muted", style: "font-size:.72rem;font-weight:400" }, i.endDate ? `échéance ${day(i.endDate)} · ` : "", h("span", { class: "mono", title: i.cid }, shortCid(i.cid))));
  }
  const odd = (x) => (x == null ? "—" : x.toFixed(2).replace(".", ",") + " $");
  // lieu d'exécution : où l'ordre est réellement passé (un signal lead-lag s'exécute sur Hyperliquid)
  const venueChip = (x) => (x.venue === "pm" ? h("span", { class: "chip neutral", title: "Parts Polymarket achetées entre 0 et 1 $ : la colonne Entrée est le prix payé par part" }, "Polymarket")
    : x.venue === "hl" || x.coin ? h("span", { class: "chip cyan", title: "Contrat perpétuel Hyperliquid : prix de l'actif réel" }, "Hyperliquid") : null);
  // cellule « Marché » : actif Hyperliquid (et le pari Polymarket qui l'a déclenché, s'il y en a un) ou marché Polymarket
  function market(x) {
    const i = pmOf(x);
    if (x.coin) return i ? pmLabel(i, { lead: h("b", {}, coinName(x.coin)) }) : h("b", {}, coinName(x.coin));
    if (i) return h("b", {}, pmLabel(i));
    return h("b", {}, x.title || x.token || x.id);
  }
  // identifiant de candidat (journal des votes) : retrouvé dans le dossier ou les positions, sinon lu dans l'identifiant
  function idLabel(rec) {
    const id = rec.candidate_id, c = D.cd?.candidates.find((x) => x.id === id) || D.pf?.positions.find((x) => x.id === id || x.candidateId === id);
    if (c?.type === "pair") return h("b", { title: id }, `${coinName(c.long.coin)} / ${coinName(c.short.coin)}`);
    if (c) return market(c);
    if (cidOf(id)) return market({ ...rec, coin: null });
    const [kind, coin, side] = String(id).split("|");
    return kind === "hl" && coin ? h("span", { title: id }, h("b", {}, coinName(coin)), " ", sideChip(side)) : h("b", { class: "mono" }, id);
  }
  const sideChip = (s) => (s ? h("span", { class: "chip " + (s === "long" ? "up" : "down") }, s === "long" ? "LONG" : "SHORT") : null);
  const table = (heads, rows) => h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map((t) => h("th", { scope: "col" }, t)))), h("tbody", {}, rows)));
  const jsonl = (txt) => txt.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  async function load() {
    const b = base(); if (!b) return;
    const get = async (f, kind) => { const r = await fetch(b + f + (App.PAGES ? "?t=" + Date.now() : ""), { cache: "no-store" }); if (!r.ok) return kind === "jsonl" ? [] : null; return kind === "jsonl" ? jsonl(await r.text()) : r.json(); };
    try {
      const [pf, mt, cd, eq, tr, vt, pm] = await Promise.all([get("portfolio_state.json"), get("metrics.json"), get("candidates.json"), get("equity_curve.jsonl", "jsonl"), get("trades_history.jsonl", "jsonl"), get("model_votes.jsonl", "jsonl"), get("pm_markets.json")]);
      Object.assign(D, { pf, mt, cd, eq, tr, vt, pm: pm || {}, at: Date.now(), err: pf ? null : "Aucun état trouvé : l'agent n'a pas encore tourné." });
    } catch (e) { D.err = "Lecture impossible : " + e.message; D.at = Date.now(); }
    render();
  }

  function kpis() {
    const p = D.pf, m = D.mt || {}, perf = m.performance || {}, t = m.trades || {}, [modeTxt, modeCls] = MODE[p.mode] || [p.mode, "neutral"];
    return h("div", { class: "kpis" },
      kpi("Capital", money(p.equity), `départ ${money(p.startCapital, 0)} · cash ${money(p.cash)}`),
      kpi("Rendement", spct(p.equity / p.startCapital - 1, 2), m.days != null ? `sur ${f2(m.days, 1)} j` : null, cls(p.equity - p.startCapital)),
      kpi("Drawdown", pct(p.drawdown || 0, 1), `max ${pctOr(perf.maxDrawdown)}`, (p.drawdown || 0) > 0.1 ? "down" : ""),
      kpi("Mode", h("span", { class: "chip " + modeCls }, modeTxt), `${p.positions.length} position(s) ouverte(s)`),
      kpi("Sharpe · Sortino", `${f2(perf.sharpe)} · ${f2(perf.sortino)}`, `Calmar ${f2(perf.calmar)} · PSR ${pctOr(perf.psr, 0)}`),
      kpi("Trades terminés", String(t.closed ?? 0), t.closed ? `réussite ${pctOr(t.winRate, 0)} · PF ${f2(t.profitFactor)}` : "aucun pour l'instant", m.significant ? "up" : ""),
    );
  }

  function curve() {
    const pts = (D.eq || []).filter((p) => p.at), cap = D.pf.startCapital, i0 = pts.findIndex((p) => p.bench?.BTC > 0 && p.bench?.GOLD > 0);
    const t = (p) => Date.parse(p.at), b0 = i0 >= 0 ? pts[i0].bench : null;
    const series = [{ name: "Agent", color: Ch.C.cyan, pts: pts.map((p) => [t(p), p.equity / cap - 1]), w: 2.6, fill: true }];
    if (b0) {
      const bp = pts.slice(i0).filter((p) => p.bench?.BTC > 0 && p.bench?.GOLD > 0);
      series.push({ name: "BTC", color: Ch.C.violet, pts: bp.map((p) => [t(p), p.bench.BTC / b0.BTC - 1]), w: 1.5, opacity: 0.85 },
        { name: "50/50 BTC-or", color: Ch.C.amber, pts: bp.map((p) => [t(p), 0.5 * p.bench.BTC / b0.BTC + 0.5 * p.bench.GOLD / b0.GOLD - 1]), w: 1.5, opacity: 0.85 });
    }
    const vs = series.flatMap((s) => s.pts.map((q) => q[1])), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), pad = Math.max(0.005, (hi - lo) * 0.15);
    const host = h("div", {});
    requestAnimationFrame(() => Ch.line(host, series, { height: 300, min: lo - pad, max: hi + pad, fmt: (v) => spct(v, 1), timeFmt: (x) => new Date(x).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit" }) }));
    const bm = D.mt?.benchmarks;
    return panel("Courbe de capital", { sub: "rendement cumulé, comparé à BTC acheté et conservé et à un panier 50/50 BTC-or",
      noteText: bm ? `Depuis ${when(bm.since)} : BTC ${spct(bm.btc.totalReturn, 2)} · 50/50 ${spct(bm.btcGold.totalReturn, 2)}` : null }, host,
      h("div", { class: "legend", style: "margin-top:8px" }, series.map((s) => h("span", {}, h("i", { style: `background:${s.color}` }), s.name))));
  }

  function positions() {
    const ps = D.pf.positions;
    if (!ps.length) return panel("Positions ouvertes", {}, empty("Aucune position ouverte."));
    return panel("Positions ouvertes", { sub: "valorisées au dernier cycle" }, table(["Marché", "Lieu", "Poche", "Sens", "Entrée", "Prix", "PnL latent", "Stop", "Échéance", "Invalidation"], ps.map((q) => {
      const pnl = q.venue === "hl" ? q.upnl : q.value - q.cost;
      return h("tr", {}, h("td", {}, market(q)), h("td", {}, venueChip(q)), h("td", {}, POCKET[q.pocket] || q.pocket), h("td", {}, sideChip(q.side)),
        h("td", { class: "mono" }, px(q.entryPx)), h("td", { class: "mono" }, px(q.mark)), h("td", { class: "mono " + cls(pnl) }, signed(pnl)),
        h("td", { class: "mono" }, q.stopPx ? px(q.stopPx) : "—"), h("td", {}, q.expiresAt ? when(q.expiresAt) : pmOf(q)?.endDate && q.venue === "pm" ? day(pmOf(q).endDate) : "—"), h("td", { class: "muted", style: "max-width:280px" }, q.invalidation || "—"));
    })));
  }

  function candidates() {
    const c = D.cd;
    if (!c) return panel("Candidats", {}, empty("Pas encore de dossier."));
    const body = c.candidates.length ? table(["Candidat", "Type", "Poche", "Score", "Indicateurs"], c.candidates.map((x) => h("tr", {},
      h("td", {}, x.type === "pair" ? h("b", {}, `${coinName(x.long.coin)} / ${coinName(x.short.coin)}`) : market(x), " ", sideChip(x.side)),
      h("td", {}, x.type), h("td", {}, POCKET[x.pocket] || x.pocket), h("td", { class: "mono" }, f2(x.score)),
      h("td", { class: "mono muted", style: "font-size:.75rem;max-width:420px" }, Object.entries(x.metrics || {}).filter(([, v]) => typeof v === "number").slice(0, 7).map(([k, v]) => `${k} ${+v.toFixed(4)}`).join(" · "))))) : empty("Aucun candidat retenu à ce cycle.");
    const rej = c.rejected.slice(0, 15);
    return panel("Candidats du dernier cycle", { sub: `${when(c.at)} · ${c.wakeLLM ? "LLM réveillés" : "LLM en veille"} (seuil de score ${c.minScore})` }, body,
      rej.length ? h("details", { style: "margin-top:10px" }, h("summary", { class: "muted" }, `${c.rejected.length} rejet(s)`), h("ul", { class: "muted", style: "font-size:.8rem;margin:6px 0 0 18px" }, rej.map((r) => h("li", {}, cidOf(r.id) ? pmLabel(pmOf({ id: r.id })) : h("span", { class: "mono" }, r.id), " : ", r.reason)))) : null);
  }

  function votes() {
    const all = D.vt || [], last = all.filter((v) => v.at).at(-1)?.at;
    if (!last) return panel("Votes des modèles", {}, empty("Aucun vote pour l'instant (les LLM ne sont réveillés que sur événement, ou faute de clé l'agent de secours décide seul)."));
    const cycle = all.filter((v) => v.at === last), dec = cycle.filter((v) => v.type === "decision"), vs = cycle.filter((v) => v.type !== "decision");
    return panel("Votes du dernier réveil", { sub: when(last) }, ...dec.map((d) => h("div", { style: "margin-bottom:14px" },
      h("div", {}, idLabel(d), " → ", h("span", { class: "chip " + (d.decision === "OPEN" ? "up" : d.decision === "CLOSE" ? "down" : "neutral") }, d.decision), " ", h("span", { class: "muted" }, d.via || ""), d.arbiter ? h("span", { class: "muted" }, ` · arbitre ${d.arbiter.model} : ${d.arbiter.reason}`) : null),
      table(["Modèle", "Vote", "Conviction", "Métrique citée", "Invalidation"], vs.filter((v) => v.candidate_id === d.candidate_id).map((v) => h("tr", {},
        h("td", { class: "mono" }, v.model, v.weight === 0 ? h("span", { class: "muted", title: "Modèle « ombre » : poids nul dans la décision, suivi seulement dans le PnL contrefactuel" }, " · ombre") : null),
        h("td", {}, h("span", { class: "chip " + (v.action === "OPEN" ? "up" : v.action === "HOLD" ? "neutral" : "down") }, v.action), v.valid ? null : h("span", { class: "muted", title: v.invalid_reason }, " écarté")),
        h("td", { class: "mono" }, v.conviction), h("td", {}, v.citation_ok ? "✓ " : "✗ ", h("span", { class: "muted" }, v.cited_risk_metric)), h("td", { class: "muted", style: "max-width:300px" }, v.invalidation_condition)))))));
  }

  function models() {
    const ms = D.mt?.models || [];
    return panel("PnL contrefactuel par modèle", { sub: "chaque vote OPEN ouvre une position fantôme ; 1 R = 1 % du capital de départ",
      noteText: "Mesure indépendante des plafonds : ce qu'aurait obtenu chaque modèle s'il avait décidé seul, en multiples du risque pris." },
      ms.length ? table(["Modèle", "Famille", "Ouvertes", "Terminées", "Réussite", "R cumulé", "R moyen", "≈ $"], ms.map((m) => h("tr", {}, h("td", { class: "mono" }, m.model), h("td", {}, m.family),
        h("td", { class: "mono" }, m.open), h("td", { class: "mono" }, m.closed), h("td", { class: "mono" }, pctOr(m.winRate, 0)), h("td", { class: "mono " + cls(m.sumR) }, f2(m.sumR)),
        h("td", { class: "mono" }, f2(m.avgR)), h("td", { class: "mono " + cls(m.pnlUsd) }, signed(m.pnlUsd || 0)))))
        : empty("Pas encore de vote."));
  }

  function history() {
    const ts = (D.tr || []).filter((t) => t.type !== "mode").slice(-50).reverse(), modes = (D.tr || []).filter((t) => t.type === "mode").slice(-5).reverse();
    return panel("Historique", { sub: "50 derniers mouvements" },
      modes.length ? h("div", { class: "chips", style: "margin-bottom:10px" }, modes.map((m) => h("span", { class: "chip " + (m.to === "normal" ? "up" : "down") }, `${when(m.at)} : ${MODE[m.from]?.[0] || m.from} → ${MODE[m.to]?.[0] || m.to}`))) : null,
      ts.length ? table(["Date", "Type", "Marché", "Lieu", "Sens", "Prix", "Montant", "Résultat", "Raison"], ts.map((t) => h("tr", {}, h("td", {}, when(t.at)), h("td", {}, t.type),
        h("td", {}, market(t)), h("td", {}, venueChip(t)), h("td", {}, sideChip(t.side)), h("td", { class: "mono" }, t.px != null ? px(t.px) : "—"), h("td", { class: "mono" }, t.usd != null ? usd(t.usd, 1) : "—"),
        h("td", { class: "mono " + cls(t.net ?? t.pnl ?? 0) }, t.net != null ? signed(t.net) : t.pnl != null ? signed(t.pnl) : "—"), h("td", { class: "muted" }, t.reason || t.decision || ""))))
        : empty("Aucun mouvement pour l'instant."));
  }

  function render() {
    if (!z.box) return;
    if (!base()) return z.box.replaceChildren(empty("Instantané : l'agent de paper trading n'est visible que sur le site en ligne ou dans la version locale (node server.mjs)."));
    if (D.err) return z.box.replaceChildren(empty(D.err));
    if (!D.pf) return z.box.replaceChildren(empty("Chargement…"));
    z.box.replaceChildren(kpis(), curve(), h("div", { class: "grid g2" }, positions(), candidates()), votes(), models(), history(),
      h("p", { class: "disclaimer" }, `Capital fictif de ${usd(D.pf.startCapital, 0)}, aucune somme réelle n'est engagée. Dernier cycle : ${when(D.pf.lastTick)}. Les ordres sont simulés sur les carnets réels d'Hyperliquid et de Polymarket ; tailles, stops et freins de drawdown sont fixés par le code, jamais par les modèles.`));
  }

  return {
    title: () => ["Agent de ", h("em", {}, "paper trading")],
    sub: "10 000 $ fictifs gérés à partir des signaux du terminal : candidats filtrés par le code, vote de trois modèles indépendants, risque et exécution déterministes.",
    init(box) { z.box = h("div", { style: "display:flex;flex-direction:column;gap:22px" }); box.append(z.box); render(); load(); },
    update() { if (Date.now() - D.at > 60_000) load(); },
  };
})();
