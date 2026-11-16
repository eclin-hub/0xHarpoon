"use strict";
/* Vues : tableau de bord, Hyperliquid, Polymarket, sentiment croisé. */

/* ---------- TABLEAU DE BORD ---------- */
App.views.dash = (() => {
  const z = {};
  return {
    title: () => ["Vue ", h("em", {}, "d'ensemble")],
    sub: "L'état du marché en un coup d'œil : où sont positionnées les baleines, ce qui bouge maintenant et ce qui mérite d'être surveillé.",
    init(box) {
      z.gauge = h("div", { class: "gauge-box" }); z.read = h("div", { class: "read" }); z.kpis = h("div", { class: "kpis", style: "margin-top:16px" });
      const hero = h("section", { class: "panel" }, h("div", { class: "body" }, h("div", { class: "hero" }, z.gauge, z.read), z.kpis));
      z.conv = h("div", {}); z.line = h("div", {}); z.setups = h("div", { class: "setups" }); z.feed = h("div", { class: "feed" });
      z.expo = h("div", {}); z.donut = h("div", { style: "display:flex;gap:22px;align-items:center;flex-wrap:wrap" }); z.crowd = h("div", {});
      z.eliteHost = h("div", {});
      z.dirs = h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px" }); z.edge = h("div", { class: "setups" }); z.top = h("div", { class: "nlist" });
      box.append(hero, panel("Directions de marché", { sub: "tous signaux confondus", tools: h("a", { href: "#dirs" }, "le détail →") }, z.dirs),
        h("div", { class: "grid g2" }, panel("Signaux d'edge", { sub: "anomalies à creuser", tools: h("a", { href: "#edge" }, "tous →") }, z.edge), panel("À la une", { tools: h("a", { href: "#news" }, "le fil →") }, z.top)),
        h("div", { class: "grid g2" }, panel("Indice boussole dans le temps", { sub: "−100 % baissier · +100 % haussier" }, z.line), panel("Dernières actions des baleines", { tools: h("a", { href: "#flux" }, "tout le flux →") }, z.feed)));
    },
    update(S) {
      const g = S.gIndex, accts = S.hl.accounts.filter((a) => !a.error), nShort = accts.filter((a) => a.shortN > a.longN).length;
      const L = accts.reduce((s, a) => s + a.longN, 0), Sh = accts.reduce((s, a) => s + a.shortN, 0), prev = historyAt(3600e3);
      const reg = X().macro?.regime, nextEv = (X().calendar?.events || []).find((e) => e.t > Date.now() && e.impact === "High");
      z.gauge.replaceChildren(Ch.gauge(g, { w: 320 }), h("div", { class: "val " + toneOf(g) + (g > 0.25 ? " glow-up" : g < -0.25 ? " glow-down" : "") }, spct(g)));
      const strongest = S.sentiment[0], aligned = S.sentiment.filter((s) => s.agree === "aligned" && Math.abs(s.score) >= 0.4);
      z.read.replaceChildren(
        h("div", { class: "muted", style: "font:500 .64rem var(--font-mono);letter-spacing:.12em;text-transform:uppercase" }, "Lecture du moment"),
        h("h2", {}, "Les baleines sont " + ({ "Très haussier": "très haussières", Haussier: "haussières", Neutre: "partagées", Baissier: "baissières", "Très baissier": "très baissières" })[label(g)]),
        h("p", {}, strongest ? `Conviction maximale sur ${strongest.name} : ${label(strongest.score).toLowerCase()} (${spct(strongest.score)}). ` : "", aligned.length ? `${aligned.length} actif${aligned.length > 1 ? "s" : ""} ${aligned.length > 1 ? "sont" : "est"} confirmé${aligned.length > 1 ? "s" : ""} par les deux plateformes.` : "Aucun actif n'est confirmé par les deux plateformes en ce moment."),
        h("div", { class: "chips" }, prev ? h("span", { class: "chip " + (g - prev.g > 0.03 ? "up" : g - prev.g < -0.03 ? "down" : "neutral") }, "1 h : " + (g - prev.g > 0 ? "+" : "") + ((g - prev.g) * 100).toFixed(0) + " pts") : h("span", { class: "chip neutral" }, "variation 1 h : en cours de collecte"),
          reg ? h("a", { class: "chip " + (reg.score >= 0.25 ? "up" : reg.score <= -0.25 ? "down" : "neutral"), href: "#macro" }, "Macro : " + reg.label.toLowerCase()) : null, nextEv ? h("a", { class: "chip warn", href: "#cal" }, "À venir : " + nextEv.cur + " " + nextEv.title) : null,
          h("span", { class: "chip cyan" }, accts.length + " comptes HL"), h("span", { class: "chip cyan" }, S.pm.whales.length + " baleines PM")));
      z.dirs.replaceChildren(...(S.dirs?.length ? S.dirs.filter((d) => d.n >= 3).map((d) => dirCard(d, true)) : [empty("Calcul en cours…")]));
      z.edge.replaceChildren(...((S.edge || []).length ? S.edge.slice(0, 4).map(edgeCard) : [empty("Aucune anomalie détectée.")]));
      const wire = X().wire || [], hot = [...wire.filter((n) => n.hot), ...wire.filter((n) => !n.hot && n.assets.length)].slice(0, 6);
      z.top.replaceChildren(...(hot.length ? hot.map((n) => newsRow(n)) : [empty("Chargement du fil…")]));
      const ev1h = S.events.filter((e) => Date.now() - e.t < 3600e3).length;
      z.kpis.replaceChildren(kpi("Comptes net short", pct(nShort / Math.max(1, accts.length)), `${nShort} sur ${accts.length}`, nShort / accts.length > 0.6 ? "down" : ""), kpi("Notionnel long", usd(L), "Hyperliquid", "up"), kpi("Notionnel short", usd(Sh), "Hyperliquid", "down"),
        kpi("Ratio short / long", (Sh / Math.max(1, L)).toFixed(1) + "×", "exposition cumulée"), kpi("Actions sur 1 h", String(ev1h), "ouvertures, ajouts, fermetures"));
      // convictions
      const top = S.sentiment.slice(0, 8);
      z.conv.replaceChildren(...(top.length ? top.map((s) => dbar(s.name, s.agree === "aligned" ? "confirmé HL + PM" : s.agree === "diverge" ? "HL et PM divergent" : "une seule source", s.score, spct(s.score), () => { ui.open.add("s:" + s.topic); location.hash = "sent"; })) : [empty("Pas encore de données croisées.")]));
      // courbe de l'indice
      const hs = S.history.filter((p) => Date.now() - p.t < 24 * 3600e3);
      Ch.line(z.line, [{ name: "Indice boussole", color: Ch.C.cyan, pts: hs.map((p) => [p.t, p.g]), fill: true, w: 2.4 }, { name: "BTC", color: Ch.C.violet, pts: hs.filter((p) => p.s.BTC != null).map((p) => [p.t, p.s.BTC]), w: 1.5, opacity: 0.85 }], { height: 330, auto: true });
      // setups
      const sets = buildSetups(S);
      z.setups.replaceChildren(...(sets.length ? sets.map(({ s, dir, pips, facts, flags, m }) => {
        const c = dir > 0 ? "var(--mint)" : "var(--rose)";
        return h("button", { class: "setup", type: "button", style: `--c:${c}`, onclick: () => { ui.open.add("s:" + s.topic); location.hash = "sent"; } },
          h("div", { class: "top" }, h("b", {}, s.name), h("span", { class: "chip " + (dir > 0 ? "up" : "down") }, dir > 0 ? "biais haussier" : "biais baissier"), m ? h("span", { class: "mono muted" }, px(m.mark)) : null, h("span", { class: "pips", title: pips + " signaux sur 4" }, [1, 2, 3, 4].map((i) => h("i", { class: i <= pips ? "on" : "" })))),
          h("ul", {}, facts.map((f) => h("li", {}, f)), flags.map((f) => h("li", { class: "warn" }, f))));
      }) : [empty("Aucun actif ne réunit assez de conviction pour l'instant.")]));
      // flux
      z.feed.replaceChildren(...(S.events.length ? S.events.slice(0, 7).map((e) => evRow(e, false)) : [empty("Aucun mouvement notable depuis le démarrage. Le flux se remplit en direct.")]));
      // exposition
      const maxG = Math.max(1, ...S.hl.coins.slice(0, 8).map((c) => c.gross));
      z.expo.replaceChildren(...S.hl.coins.slice(0, 8).map((c) => h("div", { class: "coinrow", title: `${c.nLong} comptes long · ${c.nShort} short` }, h("div", { class: "mono" }, coinName(c.coin)), h("div", { style: `width:${Math.max(10, (c.gross / maxG) * 100)}%` }, bias(c.longN, c.shortN)), h("div", { class: "mono " + cls(c.net), style: "text-align:right" }, signed(c.net)))));
      z.donut.replaceChildren(Ch.donut([{ v: L, color: Ch.C.up, label: "Long", fmt: usd }, { v: Sh, color: Ch.C.down, label: "Short", fmt: usd }], { size: 150, center: pct(Sh / (L + Sh || 1)) + " short" }),
        h("div", { class: "legend", style: "flex-direction:column" }, h("span", {}, h("i", { style: "background:var(--mint)" }), "Long ", h("b", { class: "mono" }, usd(L))), h("span", {}, h("i", { style: "background:var(--rose)" }), "Short ", h("b", { class: "mono" }, usd(Sh))), h("span", { class: "muted" }, "Capital cumulé ", usd(accts.reduce((s, a) => s + a.equity, 0)))));
      z.crowd.replaceChildren(...(S.pm.crowded.length ? S.pm.crowded.slice(0, 5).map((m) => h("a", { href: "https://polymarket.com/event/" + m.slug, target: "_blank", rel: "noopener noreferrer", style: "display:block;color:inherit;margin-bottom:10px", title: m.title },
        h("div", { style: "font-size:.82rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden" }, m.title),
        h("div", { style: "display:flex;gap:8px;align-items:center;margin-top:4px" }, h("span", { class: "chip " + (/^(yes|up|over)/i.test(m.top) ? "up" : /^(no|down|under)/i.test(m.top) ? "down" : "neutral"), title: m.top }, (m.top.length > 22 ? m.top.slice(0, 21) + "…" : m.top) + " " + pct(m.topShare)), h("span", { class: "mono muted" }, m.whales + " baleines · " + usd(m.total))))) : [empty("Pas de consensus assez large.")]));
    },
  };
})();

/* ---------- HYPERLIQUID ---------- */
function hlPositions(positions) {
  if (!positions?.length) return h("div", { class: "muted" }, "Aucune position ouverte.");
  return h("div", { class: "pos" }, ["Actif", "Notionnel", "PnL latent", "Entrée", "Levier / liq."].map((t, i) => h("div", { class: "h " + (i > 2 ? "hide-s" : "") }, t)),
    positions.flatMap((p) => [h("div", {}, h("span", { class: "chip " + (p.side === "long" ? "up" : "down") }, p.side === "long" ? "LONG" : "SHORT"), " ", Drawer.assetBtn(p.coin)), h("div", { class: "mono" }, usd(p.notional)), h("div", { class: "mono " + cls(p.upnl) }, signed(p.upnl)),
      h("div", { class: "mono hide-s" }, p.entry ? px(p.entry) : "–"), h("div", { class: "mono hide-s" }, (p.lev ? p.lev + "×" : "–") + (p.liq ? " · " + px(p.liq) : ""))]));
}
const accCache = new Map();
function lazyAccount(addr) {
  const box = h("div", { class: "muted" }, App.SNAP ? "Positions disponibles dans la version en direct." : "Chargement des positions…");
  if (App.SNAP) return box;
  if (accCache.has(addr)) { box.replaceChildren(hlPositions(accCache.get(addr).positions)); return box; }
  fetch("/api/hl/account?addr=" + addr).then((r) => r.json()).then((d) => { accCache.set(addr, d); box.replaceChildren(hlPositions(d.positions)); }).catch(() => (box.textContent = "Impossible de charger ce compte."));
  return box;
}
App.views.hl = (() => {
  const z = {}; let q = "";
  return {
    title: () => ["Baleines ", h("em", {}, "Hyperliquid")],
    sub: "Les plus gros comptes de la plateforme de contrats perpétuels : classement de PnL en direct, échantillon de référence et positions ouvertes.",
    init(box) {
      z.kpis = h("div", { class: "kpis" }); z.expo = h("div", {}); z.winSeg = h("div", { class: "seg" }); z.top = h("div", { class: "scroll limited" });
      z.search = h("input", { type: "search", class: "search", placeholder: "Filtrer par nom ou adresse", "aria-label": "Filtrer les comptes", oninput: (e) => { q = e.target.value.trim().toLowerCase(); this.fill(App.S); } });
      z.cohort = h("div", { class: "scroll limited" }); z.note = h("span", { class: "muted" });
      box.append(z.kpis, panel("Exposition de l'échantillon par actif", { sub: "notionnel long (vert) contre short (rose)" }, z.expo),
        panel("Plus gros PnL en $", { sub: "tous les comptes de la plateforme", tools: z.winSeg }, z.top),
        panel("Échantillon de référence", { sub: "", tools: z.search }, z.note, z.cohort, h("p", { class: "disclaimer", style: "margin:10px 0 0" }, "Comptes d'au moins 500 k$, actifs cette semaine, rentables sur le mois et sur toute la période, hors market makers (volume mensuel supérieur à 300 fois le capital). Classés par un score mêlant PnL du mois, PnL total, rendement du mois et taille. Cliquez un en-tête pour trier.")));
    },
    update(S) {
      const accts = S.hl.accounts.filter((a) => !a.error), L = accts.reduce((s, a) => s + a.longN, 0), Sh = accts.reduce((s, a) => s + a.shortN, 0);
      z.kpis.replaceChildren(kpi("Comptes suivis", accts.length, `sur ${S.hl.eligible} éligibles · ${S.hl.total.toLocaleString("fr-FR")} comptes au total`), kpi("Capital cumulé", usd(accts.reduce((s, a) => s + a.equity, 0))), kpi("Notionnel long", usd(L), "", "up"), kpi("Notionnel short", usd(Sh), "", "down"), kpi("Comptes net short", pct(accts.filter((a) => a.shortN > a.longN).length / Math.max(1, accts.length))));
      const maxG = Math.max(1, ...S.hl.coins.slice(0, 14).map((c) => c.gross));
      z.expo.replaceChildren(...S.hl.coins.slice(0, 14).map((c) => h("div", { class: "coinrow", title: `${c.nLong} comptes long · ${c.nShort} short` }, h("div", { class: "mono" }, coinName(c.coin)), h("div", { style: `width:${Math.max(8, (c.gross / maxG) * 100)}%` }, bias(c.longN, c.shortN)), h("div", { class: "mono " + cls(c.net), style: "text-align:right" }, signed(c.net)))));
      seg(z.winSeg, [["day", "Jour"], ["week", "Semaine"], ["month", "Mois"], ["allTime", "Tout"]], ui.hlWin, (k) => (ui.hlWin = k));
      const inC = new Map(S.hl.accounts.map((a) => [a.addr, a]));
      z.top.replaceChildren(sortableTable("hltop", [
        { t: "#", cls: "rank", cell: (_, i) => i + 1 }, { t: "Compte", cell: (r) => who(r, hlLink) },
        { t: "PnL $", cls: "r", sort: (r) => r.pnl, cell: (r) => h("span", { class: "mono " + cls(r.pnl) }, signed(r.pnl)) }, { t: "ROI", cls: "r", sort: (r) => r.roi, cell: (r) => h("span", { class: "mono " + cls(r.roi) }, spct(r.roi)) },
        { t: "Capital", cls: "r", sort: (r) => r.equity, cell: (r) => h("span", { class: "mono" }, usd(r.equity)) }, { t: "Volume", cls: "r", sort: (r) => r.vlm, cell: (r) => h("span", { class: "mono muted" }, usd(r.vlm)) }],
        S.hl.top[ui.hlWin] || [], { rowKey: (r) => "hlt:" + ui.hlWin + r.addr, defaultSort: { k: "PnL $", dir: "desc" }, detail: (r) => { const c = inC.get(r.addr); return c ? [hlPositions(c.positions), c.nPositions > c.positions.length ? h("div", { class: "muted" }, `+ ${c.nPositions - c.positions.length} autres positions`) : null] : lazyAccount(r.addr); } }));
      this.fill(S);
    },
    fill(S) {
      if (!S) return;
      const rows = S.hl.accounts.map((a, i) => ({ ...a, idx: i })).filter((a) => !q || (a.name || "").toLowerCase().includes(q) || a.addr.toLowerCase().includes(q));
      z.note.textContent = `${rows.length} comptes · positions actualisées toutes les 45 s`;
      z.cohort.replaceChildren(sortableTable("hlco", [
        { t: "#", cls: "rank", cell: (r) => r.idx + 1 }, { t: "Compte", cell: (r) => who(r, hlLink) },
        { t: "Capital", cls: "r", sort: (r) => r.equity, cell: (r) => h("span", { class: "mono" }, usd(r.equity)) },
        { t: "PnL mois", cls: "r", sort: (r) => r.month?.pnl ?? 0, cell: (r) => h("span", { class: "mono " + cls(r.month?.pnl) }, r.month ? signed(r.month.pnl) : "–") },
        { t: "ROI mois", cls: "r", sort: (r) => r.month?.roi ?? 0, cell: (r) => h("span", { class: "mono " + cls(r.month?.roi) }, r.month ? spct(r.month.roi) : "–") },
        { t: "Biais", sort: (r) => (r.longN - r.shortN) / (r.longN + r.shortN || 1), cell: (r) => bias(r.longN, r.shortN) },
        { t: "Plus grosses positions", cell: (r) => h("div", { class: "chips" }, r.positions.slice(0, 3).map((p) => h("span", { class: "chip " + (p.side === "long" ? "up" : "down") }, `${coinName(p.coin)} ${p.side === "long" ? "L" : "S"} ${usd(p.notional)}`))) }],
        rows, { rowKey: (r) => "hlc:" + r.addr, defaultSort: { k: "#", dir: "asc" }, detail: (r) => [hlPositions(r.positions), r.nPositions > r.positions.length ? h("div", { class: "muted" }, `+ ${r.nPositions - r.positions.length} autres positions`) : null] }));
    },
  };
})();

/* ---------- POLYMARKET ---------- */
const CAT_LABEL = { OVERALL: "Global", SPORTS: "Sport", POLITICS: "Politique", CRYPTO: "Crypto", FINANCE: "Finance" };
const MKT_CATS = [["all", "Tous"], ["sports", "Sport"], ["politics", "Politique"], ["crypto", "Crypto"], ["finance", "Finance"], ["other", "Autre"]];
function pmPositions(list) {
  if (!list?.length) return h("div", { class: "muted" }, "Aucune position ouverte suivie.");
  return h("div", { class: "pos" }, ["Marché", "Position", "Valeur", "PnL", "Prix"].map((t, i) => h("div", { class: "h " + (i > 2 ? "hide-s" : "") }, t)),
    list.flatMap((p) => [h("div", {}, Drawer.marketBtn(p), " ", mkLink("https://polymarket.com/event/" + p.slug, "↗")), h("div", {}, h("span", { class: "chip neutral" }, p.outcome)), h("div", { class: "mono" }, usd(p.value)), h("div", { class: "mono " + cls(p.pnl) }, signed(p.pnl)), h("div", { class: "mono hide-s" }, (p.price * 100).toFixed(0) + "¢")]));
}
App.views.pm = (() => {
  const z = {};
  return {
    title: () => ["Baleines ", h("em", {}, "Polymarket")],
    sub: "Les plus gros gagnants du marché de prédiction, par catégorie et par période, avec leurs positions ouvertes et les marchés où ils se concentrent.",
    init(box) {
      z.cat = h("div", { class: "seg" }); z.per = h("div", { class: "seg" }); z.top = h("div", { class: "scroll limited" }); z.mkt = h("div", { class: "seg" }); z.crowd = h("div", { class: "scroll limited" });
      z.donut = h("div", { style: "display:flex;gap:22px;align-items:center;flex-wrap:wrap" }); z.cohort = h("div", { class: "scroll limited" });
      box.append(h("div", { class: "grid g2" }, panel("Plus gros PnL en $", { tools: h("div", { class: "toolbar" }, z.cat, z.per) }, z.top), panel("Où est l'argent des baleines", { sub: "exposition par catégorie" }, z.donut)),
        panel("Marchés où les baleines se concentrent", { sub: "au moins 3 baleines", tools: z.mkt }, z.crowd, h("p", { class: "disclaimer", style: "margin:10px 0 0" }, "Les positions quasi résolues (prix au-dessus de 97 % ou sous 3 %) sont ignorées. Catégories déduites des titres.")),
        panel("Échantillon suivi", { sub: "top 35 du mois dans chaque catégorie" }, z.cohort));
    },
    update(S) {
      const pm = S.pm, whales = new Map(pm.whales.map((w) => [w.addr, w]));
      seg(z.cat, Object.entries(CAT_LABEL), ui.pmCat, (k) => (ui.pmCat = k)); seg(z.per, [["DAY", "Jour"], ["WEEK", "Semaine"], ["MONTH", "Mois"], ["ALL", "Tout"]], ui.pmPer, (k) => (ui.pmPer = k));
      z.top.replaceChildren(sortableTable("pmtop", [{ t: "#", cls: "rank", cell: (_, i) => i + 1 }, { t: "Compte", cell: (r) => h("span", {}, who(r, pmLink), r.verified ? h("span", { class: "chip cyan", style: "margin-left:6px" }, "vérifié") : null) },
        { t: "PnL $", cls: "r", sort: (r) => r.pnl, cell: (r) => h("span", { class: "mono " + cls(r.pnl) }, signed(r.pnl)) }, { t: "Volume", cls: "r", sort: (r) => r.vol, cell: (r) => h("span", { class: "mono muted" }, usd(r.vol)) }],
        pm.boards?.[ui.pmCat]?.[ui.pmPer] || [], { rowKey: (r) => "pmt:" + ui.pmCat + ui.pmPer + r.addr, defaultSort: { k: "PnL $", dir: "desc" }, detail: (r) => { const w = whales.get(r.addr); return w ? pmPositions(w.positions) : h("div", { class: "muted" }, "Ce compte n'est pas dans l'échantillon suivi (top 35 du mois par catégorie)."); } }));
      // donut par catégorie
      const catSum = {}; for (const w of pm.whales) for (const p of w.positions) catSum[p.category] = (catSum[p.category] || 0) + p.value;
      const CC = { sports: Ch.C.cyan, politics: Ch.C.violet, crypto: Ch.C.amber, finance: Ch.C.up, other: Ch.C.dim }, CL = { sports: "Sport", politics: "Politique", crypto: "Crypto", finance: "Finance", other: "Autre" };
      const parts = Object.entries(catSum).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ v, color: CC[k] || Ch.C.dim, label: CL[k] || k, fmt: usd }));
      z.donut.replaceChildren(Ch.donut(parts, { size: 170, thick: 20, center: usd(parts.reduce((s, p) => s + p.v, 0)) }), h("div", { class: "legend", style: "flex-direction:column" }, parts.map((p) => h("span", {}, h("i", { style: `background:${p.color}` }), p.label + " ", h("b", { class: "mono" }, usd(p.v))))));
      seg(z.mkt, MKT_CATS, ui.pmMktCat, (k) => (ui.pmMktCat = k));
      const crowd = (pm.crowded || []).filter((m) => ui.pmMktCat === "all" || m.category === ui.pmMktCat);
      z.crowd.replaceChildren(crowd.length ? sortableTable("pmcr", [{ t: "Marché", cell: (m) => h("span", {}, mkLink("https://polymarket.com/event/" + m.slug, m.title), " ", h("span", { class: "chip neutral" }, m.category)) },
        { t: "Baleines", cls: "r", sort: (m) => m.whales, cell: (m) => h("span", { class: "mono" }, m.whales) },
        { t: "Côté majoritaire", sort: (m) => m.topShare, cell: (m) => h("span", {}, h("span", { class: "chip " + (/^(yes|up|over)/i.test(m.top) ? "up" : /^(no|down|under)/i.test(m.top) ? "down" : "neutral") }, m.top), " ", h("span", { class: "mono" }, pct(m.topShare) + " des paris")) },
        { t: "Total", cls: "r", sort: (m) => m.total, cell: (m) => h("span", { class: "mono" }, usd(m.total)) }], crowd, { defaultSort: { k: "Total", dir: "desc" } }) : empty("Aucun marché ne rassemble assez de baleines dans cette catégorie."));
      z.cohort.replaceChildren(sortableTable("pmco", [{ t: "Compte", cell: (w) => who(w, pmLink) }, { t: "Catégories", cell: (w) => h("div", { class: "chips" }, w.cats.map((c) => h("span", { class: "chip neutral" }, c))) },
        { t: "PnL mois", cls: "r", sort: (w) => w.pnlMonth, cell: (w) => h("span", { class: "mono " + cls(w.pnlMonth) }, signed(w.pnlMonth)) }, { t: "Exposition", cls: "r", sort: (w) => w.total, cell: (w) => h("span", { class: "mono" }, usd(w.total)) },
        { t: "Positions actives", cls: "r", sort: (w) => w.nActive ?? w.nPositions, cell: (w) => { const act = w.nActive ?? w.nPositions, dust = w.nPositions - act; return h("span", { class: "mono", title: dust ? `${dust} positions sans valeur (paris perdus pas encore soldés)` : "" }, act, dust ? h("span", { class: "dim" }, " +" + dust) : null, w.error ? h("span", { class: "chip warn", style: "margin-left:6px" }, "relevé en attente") : w.stale ? h("span", { class: "chip neutral", style: "margin-left:6px" }, "dernier relevé") : null); } }], pm.whales,
        { rowKey: (w) => "pmc:" + w.addr, defaultSort: { k: "Exposition", dir: "desc" }, detail: (w) => [pmPositions(w.positions), w.nPositions > w.positions.length ? h("div", { class: "muted" }, `+ ${w.nPositions - w.positions.length} autres positions`) : null] }));
    },
  };
})();

/* ---------- SENTIMENT CROISÉ ---------- */
App.views.sent = (() => {
  const z = {};
  return {
    title: () => ["Sentiment ", h("em", {}, "croisé")],
    sub: "Pour chaque actif présent sur les deux plateformes : qui est long, qui est short, qui parie à la hausse ou à la baisse, et si les deux sources racontent la même histoire.",
    init(box) {
      z.grp = h("div", { class: "seg" }); z.cards = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
      box.append(panel("Classement du sentiment fort", { tools: z.grp }, z.cards, h("p", { class: "disclaimer", style: "margin:12px 0 0" }, "Score de −100 % à +100 %, mêlant poids en $ et nombre de comptes. Aligné : Hyperliquid et Polymarket vont dans le même sens. « Meilleurs comptes » : les 20 premiers de l'échantillon par rendement du mois. Sur Polymarket, le sens d'un pari est déduit du titre du marché : c'est une heuristique, vérifiez les marchés cités.")));
    },
    update(S) {
      seg(z.grp, ["all", ...new Set(S.sentiment.map((s) => s.group))].map((g) => [g, g === "all" ? "Tous" : g]), ui.sentGroup, (k) => (ui.sentGroup = k));
      const list = S.sentiment.filter((s) => ui.sentGroup === "all" || s.group === ui.sentGroup), mk = marketMap();
      if (!list.length) return z.cards.replaceChildren(empty("Pas encore assez de données croisées."));
      z.cards.replaceChildren(...list.map((s, i) => {
        const key = "s:" + s.topic, open = ui.open.has(key), m = s.coin && mk[s.coin];
        const split = (a, b, ca, cb) => { const t = a + b || 1; return h("div", { class: "bias", style: "min-width:0" }, h("i", { class: "l", style: `width:${(a / t) * 100}%;background:${ca}` }), h("i", { class: "s", style: `width:${(b / t) * 100}%;background:${cb}` })); };
        const wl = (arr, link, f) => h("div", { class: "feed" }, arr.length ? arr.map((w) => h("div", { style: "display:flex;justify-content:space-between;gap:8px;font-size:.82rem" }, who(w, link), h("span", { class: "mono" }, usd(w.notional ?? w.value)))) : [h("span", { class: "muted" }, "–")]);
        const pmEx = (arr) => h("div", { class: "feed" }, arr.slice(0, 5).flatMap((w) => w.items.slice(0, 1).map((it) => h("div", { style: "display:flex;justify-content:space-between;gap:10px;font-size:.8rem" }, h("span", {}, h("span", { class: "chip neutral" }, it.outcome), " " + it.title), h("span", { class: "mono" }, usd(it.value))))));
        const head = h("button", { type: "button", class: "dbar", style: "grid-template-columns: 28px minmax(130px,1.1fr) minmax(150px,1.3fr) minmax(130px,1fr) minmax(130px,1fr) 104px;padding:12px 14px", "aria-expanded": String(open), onclick: () => { open ? ui.open.delete(key) : ui.open.add(key); App.refresh(); } },
          h("span", { class: "mono dim" }, i + 1),
          h("div", { class: "n" }, s.name, h("small", {}, s.group + (m ? ` · ${px(m.mark)} (${spct(m.chg, 1)})` : ""))),
          h("div", {}, h("div", { class: "t", style: "position:relative;height:14px;background:rgba(255,255,255,.04);border-radius:7px" }, h("i", { style: `position:absolute;top:0;bottom:0;border-radius:7px;left:${s.score >= 0 ? 50 : 50 - Math.abs(s.score) * 50}%;width:${Math.abs(s.score) * 50}%;background:${colOf(s.score)};box-shadow:0 0 14px ${colOf(s.score)}` })), h("div", { class: "mono " + toneOf(s.score), style: "margin-top:4px" }, `${label(s.score)} ${spct(s.score)}`)),
          s.hl ? h("div", {}, h("div", { class: "mono", style: "font-size:.8rem" }, `${s.hl.nLong} long · ${s.hl.nShort} short`), split(s.hl.longN, s.hl.shortN, "var(--mint)", "var(--rose)"), h("div", { class: "dim", style: "font-size:.7rem" }, `Hyperliquid · ${usd(s.hl.longN)} / ${usd(s.hl.shortN)}`)) : h("div", { class: "dim" }, "Hyperliquid : aucune position"),
          s.pm ? h("div", {}, h("div", { class: "mono", style: "font-size:.8rem" }, `${s.pm.nBull} hauss. · ${s.pm.nBear} baiss.`), split(s.pm.bull, s.pm.bear, "var(--mint)", "var(--rose)"), h("div", { class: "dim", style: "font-size:.7rem" }, `Polymarket · ${usd(s.pm.bull)} / ${usd(s.pm.bear)}`)) : h("div", { class: "dim" }, "Polymarket : aucun pari"),
          h("div", { class: "chips", style: "flex-direction:column;align-items:flex-end" }, h("span", { class: "chip " + (s.agree === "aligned" ? "up" : s.agree === "diverge" ? "warn" : "neutral") }, s.agree === "aligned" ? "aligné" : s.agree === "diverge" ? "divergent" : "une source"),
            s.elite && s.elite.nLong + s.elite.nShort >= 4 ? h("span", { class: "chip " + (s.elite.score > 0.25 ? "up" : s.elite.score < -0.25 ? "down" : "neutral"), title: "Top 20 par ROI du mois" }, "top 20 : " + spct(s.elite.score)) : null));
        const body = open ? h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;padding:6px 18px 16px" },
          s.hl ? h("div", {}, h("h3", { style: "margin-bottom:8px" }, "HL · plus gros longs"), wl(s.hl.longers, hlLink)) : null, s.hl ? h("div", {}, h("h3", { style: "margin-bottom:8px" }, "HL · plus gros shorts"), wl(s.hl.shorters, hlLink)) : null,
          s.pm ? h("div", {}, h("h3", { style: "margin-bottom:8px" }, "PM · paris haussiers"), pmEx(s.pm.bullW)) : null, s.pm ? h("div", {}, h("h3", { style: "margin-bottom:8px" }, "PM · paris baissiers"), pmEx(s.pm.bearW)) : null) : null;
        return h("div", { style: "border:1px solid var(--line);border-radius:14px;background:rgba(5,8,22,.4)" }, head, body);
      }));
    },
  };
})();
