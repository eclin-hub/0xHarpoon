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
  const odd = (x) => (x == null ? "—" : x.toFixed(2).replace(".", ",") + " $");
  const sideChip = (s) => (s === "long" || s === "short" ? tag(s) : null);
  // cellule « Marché » sur deux lignes au plus : nom, puis une ligne secondaire coupée (texte complet au survol)
  function market(x) {
    const i = pmOf(x);
    if (x.coin) {
      const sig = i ? `signal Polymarket : ${i.title || shortCid(i.cid)}${i.outcome ? ` (${i.outcome})` : ""}` : null;
      const oddsTxt = i && (i.entryOdds != null || i.odds != null) ? ` · cote ${odd(i.entryOdds)}${i.odds != null && i.entryOdds != null ? " → " + odd(i.odds) : ""}` : "";
      return h("div", { title: sig ? `${sig}${oddsTxt}\n${i.cid}` : null }, h("b", {}, coinName(x.coin)), sig ? h("span", { class: "sub2" }, sig + oddsTxt) : null);
    }
    if (i) {
      const name = i.title || shortCid(i.cid);
      return h("div", { title: `${name}\n${i.cid}` }, i.url ? h("a", { href: i.url, target: "_blank", rel: "noopener noreferrer", style: "color:inherit;font-weight:600" }, name) : h("b", {}, name),
        h("span", { class: "sub2" }, [i.outcome, i.endDate ? `échéance ${day(i.endDate)}` : null].filter(Boolean).join(" · ")));
    }
    return h("b", {}, x.title || x.token || x.id);
  }
  // identifiant de candidat (journal des votes) : retrouvé dans le dossier ou les positions, sinon lu dans l'identifiant
  function idLabel(id) {
    const c = D.cd?.candidates.find((x) => x.id === id) || D.pf?.positions.find((x) => x.id === id || x.candidateId === id);
    if (c?.type === "pair") return h("b", { title: id }, `${coinName(c.long.coin)} / ${coinName(c.short.coin)}`);
    if (c) return market(c);
    if (cidOf(id)) return market({ id, coin: null });
    const [kind, coin, side] = String(id).split("|");
    return kind === "hl" && coin ? h("div", { title: id }, h("b", {}, coinName(coin)), h("span", { class: "sub2" }, side === "long" ? "long" : "short")) : h("b", { class: "mono", title: id }, id);
  }
  const table = (heads, rows) => h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map((t) => h("th", { scope: "col" }, t)))), h("tbody", {}, rows)));
  // ligne dépliable : un clic affiche le détail juste en dessous (fermé par défaut)
  const expandable = (cells, detail, n) => {
    const d = h("tr", { class: "detail", hidden: "" }, h("td", { colspan: n }, detail));
    const r = h("tr", { class: "row", tabindex: "0", "aria-expanded": "false", style: "cursor:pointer", onclick: () => { d.hidden = !d.hidden; r.setAttribute("aria-expanded", String(!d.hidden)); },
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.click(); } } }, cells);
    return [r, d];
  };
  const jsonl = (txt) => txt.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  async function load() {
    const b = base(); if (!b) return;
    const get = async (f, kind) => { const r = await fetch(b + f + (App.PAGES ? "?t=" + Date.now() : ""), { cache: "no-store" }); if (!r.ok) return kind === "jsonl" ? [] : null; return kind === "jsonl" ? jsonl(await r.text()) : r.json(); };
    try {
      const [pf, mt, cd, eq, tr, vt, pm, rk] = await Promise.all([get("portfolio_state.json"), get("metrics.json"), get("candidates.json"), get("equity_curve.jsonl", "jsonl"), get("trades_history.jsonl", "jsonl"), get("model_votes.jsonl", "jsonl"), get("pm_markets.json"), get("llm_ranking.json")]);
      Object.assign(D, { pf, mt, cd, eq, tr, vt, pm: pm || {}, rk, at: Date.now(), err: pf ? null : "Aucun état trouvé : l'agent n'a pas encore tourné." });
    } catch (e) { D.err = "Lecture impossible : " + e.message; D.at = Date.now(); }
    render();
  }

  // 4 indicateurs ; le reste (Sharpe, Sortino, Calmar, PSR, facteur de profit) est dans le tiroir de la courbe
  function kpis() {
    const p = D.pf, m = D.mt || {}, t = m.trades || {}, [modeTxt] = MODE[p.mode] || [p.mode];
    return h("div", { class: "kpis" },
      kpi("Équité", money(p.equity), `départ ${money(p.startCapital, 0)} · cash ${money(p.cash, 0)}`),
      kpi("Rendement", spct(p.equity / p.startCapital - 1, 2), m.days != null ? `sur ${f2(m.days, 1)} jours` : null, cls(p.equity - p.startCapital)),
      kpi("Drawdown", pct(p.drawdown || 0, 1), `max ${pctOr(m.performance?.maxDrawdown)}${p.mode !== "normal" ? ` · ${modeTxt}` : ""}`, (p.drawdown || 0) > 0.1 || p.mode !== "normal" ? "down" : ""),
      kpi("Positions ouvertes", String(p.positions.length), t.closed ? `${t.closed} trades terminés · réussite ${pctOr(t.winRate, 0)}` : "aucun trade terminé"));
  }

  function curve() {
    const pts = (D.eq || []).filter((p) => p.at), cap = D.pf.startCapital, i0 = pts.findIndex((p) => p.bench?.BTC > 0 && p.bench?.GOLD > 0);
    const t = (p) => Date.parse(p.at), b0 = i0 >= 0 ? pts[i0].bench : null;
    const series = [{ name: "Agent", color: Ch.C.cyan, pts: pts.map((p) => [t(p), p.equity / cap - 1]), w: 2.2, fill: true }];
    if (b0) {
      const bp = pts.slice(i0).filter((p) => p.bench?.BTC > 0 && p.bench?.GOLD > 0);
      series.push({ name: "BTC", color: Ch.C.violet, pts: bp.map((p) => [t(p), p.bench.BTC / b0.BTC - 1]), w: 1.3, opacity: 0.85 },
        { name: "50/50 BTC-or", color: Ch.C.amber, pts: bp.map((p) => [t(p), 0.5 * p.bench.BTC / b0.BTC + 0.5 * p.bench.GOLD / b0.GOLD - 1]), w: 1.3, opacity: 0.85 });
    }
    const vs = series.flatMap((s) => s.pts.map((q) => q[1])), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), pad = Math.max(0.005, (hi - lo) * 0.15);
    const host = h("div", {});
    requestAnimationFrame(() => Ch.line(host, series, { height: 280, min: lo - pad, max: hi + pad, fmt: (v) => spct(v, 1), timeFmt: (x) => new Date(x).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit" }) }));
    const m = D.mt || {}, perf = m.performance || {}, tr = m.trades || {}, bm = m.benchmarks;
    const stat = (l, v) => h("div", { class: "kpi" }, h("div", { class: "l" }, l), h("div", { class: "v" }, v));
    return panel("Courbe de capital", { sub: "rendement cumulé face à BTC et à un panier 50/50 BTC-or" }, host,
      h("div", { class: "legend", style: "margin:8px 0 14px" }, series.map((s) => h("span", {}, h("i", { style: `background:${s.color}` }), s.name))),
      drawer("Statistiques de performance",
        h("div", { class: "kpis" }, stat("Sharpe", f2(perf.sharpe)), stat("Sortino", f2(perf.sortino)), stat("Calmar", f2(perf.calmar)), stat("PSR", pctOr(perf.psr, 0)),
          stat("Facteur de profit", f2(tr.profitFactor)), stat("BTC sur la période", bm ? spct(bm.btc.totalReturn, 2) : "—"), stat("50/50 BTC-or", bm ? spct(bm.btcGold.totalReturn, 2) : "—"))));
  }

  // 6 colonnes : l'invalidation, la poche, l'échéance et le lieu sont dans le détail (clic sur la ligne)
  function positions() {
    const ps = D.pf.positions;
    if (!ps.length) return panel("Positions ouvertes", {}, empty("Aucune position ouverte."));
    return panel("Positions ouvertes", { sub: "valorisées au dernier cycle · clic sur une ligne pour le détail" }, table(["Marché", "Sens", "Entrée", "Prix", "PnL latent", "Stop"], ps.flatMap((q) => {
      const pnl = q.venue === "hl" ? q.upnl : q.value - q.cost;
      return expandable([h("td", {}, market(q)), h("td", {}, sideChip(q.side) || tag("pm", q.outcome || "parts")), h("td", { class: "num" }, px(q.entryPx)), h("td", { class: "num" }, px(q.mark)),
        h("td", { class: "num " + cls(pnl) }, signed(pnl)), h("td", { class: "num" }, q.stopPx ? px(q.stopPx) : "—")],
        h("div", { style: "display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.8rem" }, h("span", {}, tag(q.venue === "pm" ? "pm" : "hl")), h("span", { class: "muted" }, `poche ${POCKET[q.pocket] || q.pocket}`),
          h("span", { class: "muted" }, `ouverte ${when(q.openedAt)}`), q.expiresAt || pmOf(q)?.endDate ? h("span", { class: "muted" }, `échéance ${q.expiresAt ? when(q.expiresAt) : day(pmOf(q).endDate)}`) : null,
          q.conviction != null ? h("span", { class: "muted" }, `conviction ${q.conviction}`) : null, h("span", { style: "flex-basis:100%" }, h("span", { class: "muted" }, "Invalidation : "), q.invalidation || "—")), 6);
    })));
  }

  function candidates() {
    const c = D.cd;
    if (!c) return panel("Candidats du dernier cycle", {}, empty("Pas encore de dossier."));
    const metricsTxt = (x) => Object.entries(x.metrics || {}).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k} ${+v.toFixed(4)}`).join(" · ");
    const body = c.candidates.length ? table(["Candidat", "Sens", "Type", "Score", "Indicateurs"], c.candidates.map((x) => h("tr", {},
      h("td", {}, x.type === "pair" ? h("b", {}, `${coinName(x.long.coin)} / ${coinName(x.short.coin)}`) : market(x)), h("td", {}, sideChip(x.side)),
      h("td", { class: "muted" }, x.type), h("td", { class: "num" }, f2(x.score)), h("td", { class: "muted mono", style: "font-size:.74rem", title: metricsTxt(x) }, metricsTxt(x))))) : empty("Aucun candidat au-dessus du seuil à ce cycle.");
    return panel("Candidats du dernier cycle", { sub: `${when(c.at)} · ${c.wakeLLM ? "LLM réveillés" : "LLM en veille"} · seuil ${c.minScore}` }, body,
      c.rejected.length ? h("div", { style: "margin-top:12px" }, drawer(`${c.rejected.length} candidat(s) écarté(s) par les filtres`,
        table(["Candidat", "Raison"], c.rejected.slice(0, 40).map((r) => h("tr", {}, h("td", {}, idLabel(r.id)), h("td", { class: "muted", title: r.reason }, r.reason)))))) : null);
  }

  // Une ligne par décision ; les votes de chaque modèle se déplient au clic (au lieu d'un tableau par candidat)
  function votes() {
    const all = D.vt || [], last = all.filter((v) => v.at && v.type !== "meta").at(-1)?.at;
    if (!last) return panel("Décisions du dernier réveil", {}, empty("Aucun vote pour l'instant : les modèles ne sont réveillés que sur événement."));
    const cycle = all.filter((v) => v.at === last), dec = cycle.filter((v) => v.type === "decision"), vs = cycle.filter((v) => v.type !== "decision" && v.type !== "meta");
    const dchip = (x) => h("span", { class: "chip " + (x === "OPEN" ? "up" : x === "CLOSE" || x === "REJECT" ? "down" : "neutral") }, x);
    const tally = (id) => { const v = vs.filter((x) => x.candidate_id === id && x.weight !== 0 && x.valid !== false), c = {}; for (const x of v) c[x.action] = (c[x.action] || 0) + 1; return Object.entries(c).map(([k, n]) => `${n} ${k}`).join(" · ") || "—"; };
    return panel("Décisions du dernier réveil", { sub: `${when(last)} · clic sur une ligne pour les votes de chaque modèle` },
      table(["Candidat ou position", "Décision", "Votes", "Conviction", "Voie"], dec.flatMap((d) => expandable([h("td", {}, idLabel(d.candidate_id)), h("td", {}, dchip(d.decision)),
        h("td", { class: "muted" }, tally(d.candidate_id)), h("td", { class: "num" }, d.conviction ?? "—"), h("td", { class: "muted", title: d.arbiter ? `arbitre ${d.arbiter.model} : ${d.arbiter.reason}` : null }, d.via || "")],
        h("div", {}, d.arbiter ? h("p", { class: "muted", style: "margin:0 0 8px;font-size:.8rem" }, `Arbitre ${d.arbiter.model} : ${d.arbiter.reason}`) : null,
          table(["Modèle", "Vote", "Conviction", "Métrique citée", "Invalidation"], vs.filter((v) => v.candidate_id === d.candidate_id).map((v) => h("tr", {},
            h("td", { class: "mono" }, v.model, v.weight === 0 ? h("span", { class: "sub2" }, v.probe ? "ombre : repêchage, poids nul" : "ombre : poids nul") : typeof v.weight === "number" && v.weight < 1 ? h("span", { class: "sub2" }, `poids ${pct(v.weight, 0)}`) : null), h("td", {}, dchip(v.action), v.valid ? null : h("span", { class: "muted", title: v.invalid_reason }, " écarté")),
            h("td", { class: "num" }, v.conviction), h("td", { class: "muted", title: v.cited_risk_metric }, (v.citation_ok ? "✓ " : "✗ ") + (v.cited_risk_metric || "")), h("td", { class: "muted", title: v.invalidation_condition }, v.invalidation_condition))))), 5))));
  }

  // Classement dynamique des modèles (llm_ranking.json) : remplace l'ancien tableau du PnL contrefactuel par modèle
  function models() {
    const rk = D.rk, ms = rk?.models || [];
    const st = (m) => h("span", { class: "chip " + (m.status.startsWith("Actif") ? "up" : "neutral"), title: m.fails ? `échecs récents ${pct(m.fails, 0)}${rk.health?.[m.model]?.lastError ? " · " + rk.health[m.model].lastError : ""}` : null }, m.status);
    const P = rk?.params || {};
    return panel("Classement des modèles IA", { sub: `${rk ? when(rk.at) + " · " : ""}${P.minActive ?? 6} votants actifs au plus, poids plafonné à ${pct(P.cap ?? P.maxWeight ?? 0.3, 0)} · trades fantômes clos sur ${P.windowDays ?? 30} j (${P.maxTrades ?? 40} au plus)`,
      noteText: "Score : PSR, facteur de profit et taux de réussite des trades fantômes (chaque vote OPEN valide ouvre une position fantôme pour son modèle), ramenés vers 1 (neutre) par un prior bayésien : score neutre sous 5 trades clos, légère pénalité en cas d'échecs répétés. Les 6 meilleurs de familles distinctes votent avec un poids proportionnel à leur score, plafonné à 30 % ; les autres sont en sourdine (poids nul), mais 2 d'entre eux votent en ombre à chaque réveil et redeviennent actifs dès qu'ils remontent dans le Top 6. 1 R = 1 % du capital de départ." },
      ms.length ? table(["Modèle", "Statut", "Trades shadow", "Réussite", "R cumulé · Sharpe", "Poids de vote"], ms.map((m) => h("tr", {},
        h("td", { class: "mono", title: `rang ${m.rank} · famille ${m.family} · ${m.provider} · score ${f2(m.score, 2)}` }, m.model, h("span", { class: "sub2" }, `#${m.rank} · score ${f2(m.score, 2)}`)),
        h("td", {}, st(m)), h("td", { class: "num" }, String(m.trades)), h("td", { class: "num" }, pctOr(m.winRate, 0)),
        h("td", { class: "num " + cls(m.sumR || 0) }, `${f2(m.sumR)} R · ${f2(m.sharpe)}`), h("td", { class: "num" }, m.weight > 0 ? pct(m.weight, 1) : "0 %"))))
        : empty("Pas encore de classement : il apparaît au premier cycle avec une clé LLM."));
  }

  // 6 colonnes ; type et raison en ligne secondaire ; changements de mode dans un tiroir
  function history() {
    const ts = (D.tr || []).filter((t) => t.type !== "mode").slice(-100).reverse(), modes = (D.tr || []).filter((t) => t.type === "mode").slice(-10).reverse();
    const TYPE = { open: "ouverture", close: "fermeture", reduce: "réduction", settle: "résolution" };
    return panel("Historique des trades", { sub: `${ts.length} derniers mouvements` },
      ts.length ? table(["Date", "Marché", "Sens", "Prix", "Montant", "Résultat"], ts.map((t) => h("tr", { title: [TYPE[t.type] || t.type, t.reason || t.decision].filter(Boolean).join(" · ") },
        h("td", { class: "muted" }, when(t.at), h("span", { class: "sub2" }, TYPE[t.type] || t.type)), h("td", {}, market(t)), h("td", {}, sideChip(t.side)),
        h("td", { class: "num" }, t.px != null ? px(t.px) : "—"), h("td", { class: "num" }, t.usd != null ? usd(t.usd, 1) : "—"),
        h("td", { class: "num " + cls(t.net ?? t.pnl ?? 0) }, t.net != null ? signed(t.net) : t.pnl != null ? signed(t.pnl) : "—")))) : empty("Aucun mouvement pour l'instant."),
      modes.length ? h("div", { style: "margin-top:12px" }, drawer(`Changements de mode de risque (${modes.length})`, h("div", { class: "chips" }, modes.map((m) => h("span", { class: "chip " + (m.to === "normal" ? "up" : "down") }, `${when(m.at)} : ${MODE[m.from]?.[0] || m.from} → ${MODE[m.to]?.[0] || m.to}`))))) : null);
  }

  function render() {
    if (!z.box) return;
    if (!base()) return z.box.replaceChildren(empty("Instantané : l'agent de paper trading n'est visible que sur le site en ligne ou dans la version locale (node server.mjs)."));
    if (D.err) return z.box.replaceChildren(empty(D.err));
    if (!D.pf) return z.box.replaceChildren(empty("Chargement…"));
    z.box.replaceChildren(kpis(), regimeBand(D.mt?.regime) || "", curve(), positions(), candidates(), votes(), models(), history(),
      h("p", { class: "disclaimer" }, `Capital fictif, aucune somme réelle engagée · dernier cycle ${when(D.pf.lastTick)} · ordres simulés sur les carnets réels ; tailles, stops et freins de drawdown fixés par le code.`));
  }

  return {
    title: () => ["Agent de ", h("em", {}, "paper trading")],
    sub: "10 000 $ fictifs : candidats filtrés par le code, vote pondéré de 6 modèles classés sur leurs résultats, risque et exécution déterministes.",
    init(box) { z.box = h("div", { style: "display:flex;flex-direction:column;gap:var(--gap)" }); box.append(z.box); render(); load(); },
    update() { if (Date.now() - D.at > 60_000) load(); },
  };
})();
