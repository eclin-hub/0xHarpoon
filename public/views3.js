"use strict";
/* Monde : globe, fil d'info, réseaux, calendrier, probabilités. */

/* ---------- GLOBE ---------- */
App.views.globe = (() => {
  const z = {}; let g = null, sel = null, cache = {}, blocId = null;
  const KL = { guerre: "Guerre", insurrection: "Insurrection", tension: "Tension", commerce: "Conflit commercial" };
  const SIDE_COL = ["#4f8cff", "#ff8a3d"], SIDE_FILL = ["rgba(79,140,255,0.45)", "rgba(255,138,61,0.45)"];
  const put = (...kids) => z.side.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const nameOf = (iso) => g?.world()?.names?.[iso] || iso;
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  function heat() { const out = {}, cn = X().countryNews || {}; for (const [iso, list] of Object.entries(cn)) { const n = list.filter((i) => i.themes?.includes("Géopolitique")).length; if (n >= 4) out[iso] = Math.min(1, (n - 3) / 5); } return out; }
  const relatedOdds = (iso) => (X().odds?.events || []).filter((e) => e.countries?.includes(iso)).slice(0, 6);
  function oddsList(list) { return list.length ? h("div", { class: "feed" }, list.map((e) => h("a", { class: "orow", href: "https://polymarket.com/event/" + e.slug, target: "_blank", rel: "noopener noreferrer" }, h("span", {}, e.title, e.n > 1 ? h("span", { class: "dim" }, " · " + e.markets[0].q) : null), h("span", { class: "mono " + (e.markets[0].d1 > 0.02 ? "up" : e.markets[0].d1 < -0.02 ? "down" : "") }, (e.markets[0].p * 100).toFixed(0) + " %")))) : h("div", { class: "muted" }, "Aucun marché de prédiction lié."); }
  const cchip = (iso, tone) => h("button", { class: "chip " + (tone || "neutral") + " cbtn", type: "button", onclick: () => openCountry(iso) }, nameOf(iso));
  const gdpShare = (members) => { const wb = X().wb?.countries; if (!wb) return null; const world = wb["1W"]?.gdp?.v; if (!world) return null; return members.reduce((s, i) => s + (wb[i]?.gdp?.v || 0), 0) / world; };
  const back = () => h("button", { class: "btn", type: "button", onclick: () => { clearOverlay(); showList(); } }, "← vue d'ensemble");
  function clearOverlay(keepBloc) { g?.overlay({ rel: null, arcs: [], ...(keepBloc ? {} : { bloc: blocId ? blocOverlay(blocId) : null }) }); }
  const blocOverlay = (id) => { const b = GEO.BLOCS.find((x) => x.id === id); return b ? { set: new Set(b.members), fill: hexA(b.color, 0.45) } : null; };
  function setBloc(id) { blocId = id; g?.overlay({ bloc: id ? blocOverlay(id) : null }); renderBlocSeg(); }
  function renderBlocSeg() { z.blocs.replaceChildren(...[["", "Aucun bloc"], ...GEO.BLOCS.map((b) => [b.id, b.name])].map(([id, l]) => { const b = GEO.BLOCS.find((x) => x.id === id); return h("button", { type: "button", "aria-pressed": String((blocId || "") === id), onclick: () => { setBloc(id || null); if (id) showBloc(id); } }, b ? h("i", { class: "dot", style: `background:${b.color};box-shadow:0 0 8px ${b.color}` }) : null, l); })); }

  function showList() {
    sel = null; g?.clearSel(); const cs = [...(X().conflicts || [])].sort((a, b) => b.level - a.level);
    put(h("h2", {}, "Foyers de tension"), h("p", { class: "muted", style: "margin:4px 0 12px;font-size:.8rem" }, "Cliquez un point, un pays ou un bloc. Faites glisser pour tourner, molette pour zoomer."),
      h("div", { class: "feed" }, cs.map((c) => h("button", { class: "crow", type: "button", onclick: () => { g?.selectPoint(c); showConflict(c); } }, h("i", { style: `background:${Globe.KIND[c.kind]};box-shadow:0 0 10px ${Globe.KIND[c.kind]}` }), h("span", { class: "n" }, c.name), h("span", { class: "chip neutral" }, KL[c.kind]), h("span", { class: "pips", style: `--c:${Globe.KIND[c.kind]}` }, [1, 2, 3].map((i) => h("i", { class: i <= c.level ? "on" : "" })))))),
      (X().quakes?.list || []).length ? h("div", { style: "margin-top:16px" }, h("h3", { style: "margin-bottom:8px" }, "Séismes majeurs (7 jours)"), h("div", { class: "feed" }, X().quakes.list.slice(0, 5).map((q) => h("button", { class: "crow", type: "button", onclick: () => g?.flyTo(q.lon, q.lat, 1.8) }, h("i", { style: "background:var(--amber)" }), h("span", { class: "n" }, q.place), h("span", { class: "mono warn" }, "M " + q.mag.toFixed(1)))))) : null);
  }
  function showConflict(c) {
    sel = { type: "conflict", id: c.id }; const sides = GEO.SIDES[c.id] || [];
    const fill = {}, arcs = [];
    sides.forEach((sd, i) => { const anchor = g?.pt(sd.iso[0]); for (const iso of [...sd.iso, ...sd.support]) fill[iso] = SIDE_FILL[i]; if (anchor) for (const sp of sd.support) { const p = g?.pt(sp); if (p) arcs.push({ a: p, b: anchor, color: SIDE_COL[i] }); } });
    g?.overlay({ rel: { allies: new Set(), rivals: new Set(), sides: fill }, arcs, bloc: null });
    put(back(), h("h2", { style: "margin-top:12px" }, c.name), h("div", { class: "chips", style: "margin:8px 0" }, h("span", { class: "chip", style: `color:${Globe.KIND[c.kind]};border-color:${Globe.KIND[c.kind]}` }, KL[c.kind]), h("span", { class: "chip neutral" }, "impact " + ["local", "régional", "mondial"][c.level - 1]), c.assets.map((a) => h("span", { class: "chip cyan" }, ASSET_LBL[a] || a))),
      h("p", { class: "muted", style: "margin:0 0 12px" }, c.note),
      sides.length ? h("div", { class: "sides" }, sides.map((sd, i) => h("div", { class: "sidebox", style: `--c:${SIDE_COL[i]}` }, h("b", {}, sd.name), h("div", { class: "chips" }, sd.iso.map((iso) => cchip(iso))), sd.support.length ? [h("div", { class: "dim", style: "font-size:.72rem;margin-top:6px" }, "Soutiens"), h("div", { class: "chips" }, sd.support.map((iso) => cchip(iso)))] : h("div", { class: "dim", style: "font-size:.72rem;margin-top:6px" }, "Pas de soutien extérieur majeur déclaré")))) : h("div", { class: "chips", style: "margin-bottom:14px" }, c.iso.map((iso) => cchip(iso))),
      h("h3", { style: "margin:14px 0 8px" }, "Dernières infos"), c.news?.length ? h("div", { class: "nlist" }, c.news.map((n) => newsRow(n))) : h("div", { class: "muted" }, "Pas d'info récente."),
      h("h3", { style: "margin:16px 0 8px" }, "Ce que parient les marchés"), oddsList([...new Map(c.iso.flatMap(relatedOdds).map((e) => [e.id, e])).values()].slice(0, 6)));
  }
  function openCountry(iso) { const f = g?.select(iso) || { iso2: iso, nameFr: nameOf(iso) }; if (!g?.world()?.byIso[iso]) { const p = g?.pt(iso); if (p) g.flyTo(p[0], p[1], 2); } showCountry(f); }
  function showCountry(f) {
    const iso = f.iso2; sel = { type: "country", iso };
    const geo = GEO.C[iso], blocs = GEO.blocsOf(iso), wb = X().wb?.countries?.[iso], confl = (X().conflicts || []).filter((c) => c.iso.includes(iso)), newsBox = h("div", {});
    const here = g?.pt(iso), arcs = [];
    if (geo && here) { for (const a of geo.allies) { const p = g.pt(a); if (p) arcs.push({ a: here, b: p, color: "#2bffb0" }); } for (const r of geo.rivals) { const p = g.pt(r); if (p) arcs.push({ a: here, b: p, color: "#ff3d86" }); } }
    g?.overlay({ rel: geo ? { allies: new Set(geo.allies), rivals: new Set(geo.rivals) } : null, arcs, bloc: null });
    const fill = (list) => newsBox.replaceChildren(list?.length ? h("div", { class: "nlist" }, list.map((n) => newsRow(n))) : h("div", { class: "muted" }, "Pas d'info récente trouvée."));
    const pre = X().countryNews?.[iso] || cache[iso];
    if (pre) fill(pre); else if (App.SNAP || !iso) newsBox.replaceChildren(h("div", { class: "muted" }, iso ? "L'actualité de ce pays n'est pas préchargée (elle se charge au clic dans la version locale)." : "Pas de données pour ce territoire.")); else { newsBox.replaceChildren(h("div", { class: "muted" }, "Chargement de l'actualité…")); fetch("/api/country?iso=" + iso).then((r) => r.json()).then((d) => { cache[iso] = d || []; if (sel?.iso === iso) fill(cache[iso]); }).catch(() => fill([])); }
    const stat = (l, o, fm) => o ? h("div", { class: "kpi", style: "padding:10px 12px" }, h("div", { class: "l" }, l), h("div", { class: "v", style: "font-size:1.05rem" }, fm(o.v)), h("div", { class: "s" }, o.y)) : null;
    put(back(), h("h2", { style: "margin-top:12px" }, f.nameFr || nameOf(iso)),
      blocs.length ? h("div", { class: "chips", style: "margin:8px 0" }, blocs.map((b) => h("button", { class: "chip cbtn", type: "button", style: `color:${b.color};border-color:${b.color}`, onclick: () => { setBloc(b.id); showBloc(b.id); } }, b.name))) : null,
      geo?.role ? h("p", { style: "margin:6px 0" }, geo.role) : null, geo?.sanctions ? h("p", { class: "warn", style: "margin:4px 0;font-size:.84rem" }, "Sanctions : " + geo.sanctions) : null,
      geo && (geo.allies.length || geo.rivals.length) ? h("div", { class: "rel" }, geo.allies.length ? h("div", {}, h("div", { class: "dim lbl" }, "Alliés et partenaires proches"), h("div", { class: "chips" }, geo.allies.map((a) => cchip(a, "up")))) : null, geo.rivals.length ? h("div", {}, h("div", { class: "dim lbl" }, "Rivaux et adversaires"), h("div", { class: "chips" }, geo.rivals.map((r) => cchip(r, "down")))) : null) : !geo ? h("p", { class: "dim", style: "font-size:.8rem" }, "Pas de fiche géopolitique détaillée pour ce pays.") : null,
      wb ? h("div", { class: "kpis", style: "grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0" }, stat("PIB", wb.gdp, (v) => usd(v)), stat("Croissance", wb.gdpGrowth, (v) => spct(v / 100, 1)), stat("Inflation", wb.inflation, (v) => v.toFixed(1) + " %"), stat("Chômage", wb.unemployment, (v) => v.toFixed(1) + " %"), stat("Dette publique", wb.debt, (v) => v.toFixed(0) + " % du PIB")) : null,
      confl.length ? h("div", { style: "margin-bottom:12px" }, h("h3", { style: "margin-bottom:8px" }, "Foyers de tension liés"), h("div", { class: "chips" }, confl.map((c) => h("button", { class: "btn hot", type: "button", onclick: () => { g?.selectPoint(c); showConflict(c); } }, c.name)))) : null,
      h("h3", { style: "margin-bottom:8px" }, "Dernières infos"), newsBox, h("h3", { style: "margin:16px 0 8px" }, "Ce que parient les marchés"), oddsList(relatedOdds(iso)));
  }
  function showBloc(id) {
    const b = GEO.BLOCS.find((x) => x.id === id); if (!b) return; sel = { type: "bloc", id }; g?.overlay({ rel: null, arcs: [] }); g?.clearSel();
    const share = gdpShare(b.members);
    put(back(), h("h2", { style: "margin-top:12px;color:" + b.color }, b.name), h("div", { class: "chips", style: "margin:8px 0" }, h("span", { class: "chip neutral" }, b.kind), h("span", { class: "chip neutral" }, b.members.length + " membres"), share != null ? h("span", { class: "chip cyan" }, pct(share) + " du PIB mondial") : null),
      h("p", { class: "muted" }, b.desc), h("h3", { style: "margin:12px 0 8px" }, "Membres"), h("div", { class: "chips" }, b.members.map((iso) => cchip(iso))));
  }
  return {
    title: () => ["Globe ", h("em", {}, "géopolitique")],
    sub: "Foyers de tension, camps et soutiens, blocs et alliances, rôle économique de chaque pays. Cliquez un pays pour voir ses alliés et rivaux (liens verts et roses), son poids économique, son actualité et ce que parient les marchés.",
    init(box) {
      z.globe = h("div", { class: "globe-host" }); z.side = h("div", { class: "globe-side" }); z.blocs = h("div", { class: "seg blocseg" }); z.cards = h("div", { class: "bloccards" });
      const lay = (k, lab) => h("button", { class: "btn on", type: "button", onclick: (e) => { const on = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", on); g?.layers({ [k]: on }); } }, lab);
      const tools = h("div", { class: "toolbar" }, lay("conflicts", "Conflits"), lay("heat", "Pays sous tension"), lay("quakes", "Séismes"), h("button", { class: "btn", type: "button", onclick: () => g?.zoom(1.3), "aria-label": "Zoomer" }, "＋"), h("button", { class: "btn", type: "button", onclick: () => g?.zoom(0.77), "aria-label": "Dézoomer" }, "−"), h("button", { class: "btn", type: "button", onclick: () => g?.spin(true) }, "Rotation auto"));
      const legend = h("div", { class: "legend", style: "margin-top:10px" }, Object.entries(KL).map(([k, l]) => h("span", {}, h("i", { style: `background:${Globe.KIND[k]};border-radius:50%` }), l)), h("span", {}, h("i", { style: "background:transparent;border:1.5px solid var(--amber);border-radius:50%" }), "Séisme"), h("span", {}, h("i", { style: "background:var(--mint)" }), "Allié"), h("span", {}, h("i", { style: "background:var(--rose)" }), "Rival"));
      box.append(h("div", { class: "toolbar" }, z.blocs), h("div", { class: "globe-grid" }, h("section", { class: "panel" }, h("div", { class: "body" }, tools, z.globe, legend, h("p", { class: "disclaimer", style: "margin:10px 0 0" }, "Foyers, alliances, rivalités et soutiens : base éditoriale arrêtée à mi-2026, simplifiée (les relations réelles sont plus nuancées). L'actualité, les chiffres économiques et les cotes sont chargés en direct."))), h("section", { class: "panel" }, h("div", { class: "body" }, z.side))),
        panel("Blocs et alliances", { sub: "poids dans l'économie mondiale · clic pour les voir sur le globe" }, z.cards));
      renderBlocSeg();
      g = Globe.create(z.globe, { onCountry: showCountry, onPoint: (d, t) => (t === "quake" ? null : showConflict(d)),
        onHover: (e, hit) => { if (!e || !hit) return Ch.hideTip(); if (hit.type === "country") { const geo = GEO.C[hit.d.iso2], bl = GEO.blocsOf(hit.d.iso2).map((b) => b.name).join(", "); return Ch.showTip(e, [h("b", {}, hit.d.nameFr), bl ? h("div", { class: "muted" }, bl) : null, geo?.role ? h("div", { style: "max-width:260px" }, geo.role) : "Cliquer pour la fiche"].filter(Boolean)); }
          Ch.showTip(e, hit.type === "quake" ? [h("b", {}, "Séisme M " + hit.d.mag.toFixed(1)), hit.d.place] : [h("b", {}, hit.d.name), KL[hit.d.kind]]); } });
    },
    update(S) {
      g?.set({ points: X().conflicts || [], quakes: X().quakes?.list || [], heat: heat() }); g?.start();
      z.cards.replaceChildren(...GEO.BLOCS.map((b) => { const share = gdpShare(b.members); return h("button", { type: "button", class: "bcard" + (blocId === b.id ? " on" : ""), style: `--c:${b.color}`, onclick: () => { setBloc(b.id); showBloc(b.id); z.globe.scrollIntoView({ behavior: "smooth", block: "center" }); App.refresh(); } },
        h("div", { class: "row" }, h("b", {}, b.name), h("span", { class: "dim mono", style: "font-size:.72rem" }, b.members.length + " pays")), h("div", { class: "bar" }, h("i", { style: `width:${Math.min(100, (share || 0) * 100)}%` })), h("div", { class: "row" }, h("span", { class: "dim", style: "font-size:.74rem" }, b.kind), h("span", { class: "mono", style: "font-size:.8rem" }, share != null ? pct(share) + " du PIB mondial" : "")), h("div", { class: "muted", style: "font-size:.76rem;text-align:left" }, b.desc)); }));
      if (!sel) showList(); else if (sel.type === "conflict") { const c = (X().conflicts || []).find((x) => x.id === sel.id); if (c && !z.side.contains(document.activeElement)) showConflict(c); }
    },
    leave() { g?.stop(); Ch.hideTip(); },
  };
})();

/* ---------- FIL D'INFO ---------- */
App.views.news = (() => {
  const z = {}; let theme = "all", hotOnly = false;
  return {
    title: () => ["Fil ", h("em", {}, "d'info")],
    sub: "Les dépêches économiques, politiques et géopolitiques du moment, étiquetées par thème et par actif potentiellement touché. Actualisé toutes les 3 minutes.",
    init(box) { z.seg = h("div", { class: "seg" }); z.themes = h("div", {}); z.list = h("div", { class: "nlist" }); z.hot = h("button", { class: "btn hot", type: "button", onclick: () => { hotOnly = !hotOnly; App.refresh(); } }, "Urgent seulement");
      box.append(h("div", { class: "toolbar" }, z.seg, z.hot), h("div", { class: "grid", style: "grid-template-columns:minmax(0,2.2fr) minmax(0,1fr)" }, panel("Dépêches", {}, z.list), panel("Thèmes dominants", { sub: "part des dépêches" }, z.themes))); },
    update(S) {
      const wire = X().wire || [], counts = {}; for (const n of wire) for (const t of n.themes) counts[t] = (counts[t] || 0) + 1;
      const ths = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      z.seg.replaceChildren(...[["all", "Tout"], ...ths.slice(0, 9).map(([t]) => [t, t])].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === theme), onclick: () => { theme = k; App.refresh(); } }, l)));
      z.hot.classList.toggle("on", hotOnly);
      const list = wire.filter((n) => (theme === "all" || n.themes.includes(theme)) && (!hotOnly || n.hot));
      z.list.replaceChildren(...(list.length ? list.slice(0, 80).map((n) => newsRow(n)) : [empty(wire.length ? "Aucune dépêche avec ce filtre." : "Chargement du fil…")]));
      const mx = Math.max(1, ...ths.map((t) => t[1]));
      z.themes.replaceChildren(...ths.map(([t, n]) => h("button", { class: "coinrow", type: "button", style: "width:100%;background:none;border:0;text-align:left;grid-template-columns:120px minmax(0,1fr) 34px", onclick: () => { theme = t; App.refresh(); } }, h("div", {}, t), h("div", { class: "bias", style: "height:10px" }, h("i", { class: "l", style: `width:${(n / mx) * 100}%;background:var(--cyan);box-shadow:0 0 10px var(--cyan)` })), h("div", { class: "mono", style: "text-align:right" }, n))));
    },
  };
})();

/* ---------- RÉSEAUX ---------- */
App.views.social = (() => {
  const z = {}; let net = "all";
  return {
    title: () => ["Réseaux en ", h("em", {}, "direct")],
    sub: "Les comptes qui font bouger les marchés avant les médias : canaux Telegram d'alertes, publications de Donald Trump sur Truth Social, et X une fois branché.",
    init(box) { z.status = h("div", { class: "chips" }); z.seg = h("div", { class: "seg" }); z.list = h("div", { class: "nlist" }); z.setup = h("div", {});
      box.append(panel("Sources", {}, z.status), h("div", { class: "grid", style: "grid-template-columns:minmax(0,2fr) minmax(0,1fr)" }, panel("Publications", { tools: z.seg }, z.list), panel("Brancher X (Twitter)", {}, z.setup))); },
    update(S) {
      const so = X().social || { status: {}, items: [] };
      z.status.replaceChildren(...Object.entries(so.status).map(([k, v]) => h("span", { class: "chip " + (v === "ok" ? "up" : v === "à configurer" ? "warn" : "neutral") }, `${k} : ${v}`)));
      const nets = ["all", ...new Set(so.items.map((i) => i.net))]; seg(z.seg, nets.map((n) => [n, n === "all" ? "Tout" : n]), net, (k) => (net = k));
      const list = so.items.filter((i) => net === "all" || i.net === net);
      z.list.replaceChildren(...(list.length ? list.slice(0, 80).map((n) => newsRow(n, { net: true })) : [empty("Aucune publication pour l'instant.")]));
      z.setup.replaceChildren(h("p", { class: "muted", style: "margin:0 0 10px" }, so.xMode ? `X est branché (mode ${so.xMode}).` : "X ne fournit plus d'accès public gratuit : il faut une clé. Trois branchements sont prévus, à activer par une variable d'environnement au lancement du serveur :"),
        h("div", { class: "feed" }, [["X_BEARER_TOKEN", "API officielle de X (payante). La voie la plus fiable."], ["TWITTERAPI_IO_KEY", "Service tiers twitterapi.io, celui qu'utilise le dépôt polymarket-whale-watcher. Bien moins cher."], ["X_RSS_BASE", "Adresse d'une instance RSSHub ou Nitter que vous hébergez vous-même."]].map(([k, d]) => h("div", { class: "check" }, h("span", { class: "mono", style: "color:var(--cyan)" }, k), h("span", { class: "muted" }, d)))),
        h("p", { class: "muted", style: "margin:12px 0 6px" }, "Comptes suivis (variable X_ACCOUNTS) :"), h("div", { class: "chips" }, (X().xAccounts || []).map((a) => h("span", { class: "chip neutral" }, "@" + a))),
        h("p", { class: "disclaimer", style: "margin:12px 0 0" }, "Canaux Telegram modifiables avec TELEGRAM_CHANNELS. Truth Social passe par l'archive publique trumpstruth.org."));
    },
  };
})();

/* ---------- CALENDRIER ---------- */
App.views.cal = (() => {
  const z = {}; let imp = "med", cur = "all";
  const IMP = { High: ["Fort", "down"], Medium: ["Moyen", "warn"], Low: ["Faible", "neutral"], Holiday: ["Férié", "neutral"] };
  return {
    title: () => ["Calendrier ", h("em", {}, "économique")],
    sub: "Les publications de la semaine qui font bouger les taux, les devises et les actions : inflation, emploi, décisions de banques centrales. Heures affichées dans votre fuseau.",
    init(box) { z.kpis = h("div", { class: "kpis" }); z.imp = h("div", { class: "seg" }); z.cur = h("div", { class: "seg" }); z.list = h("div", {}); box.append(z.kpis, h("div", { class: "toolbar" }, z.imp, z.cur), panel("Semaine en cours", {}, z.list)); },
    update(S) {
      const ev = X().calendar?.events || [], now = Date.now(), next = ev.find((e) => e.t > now && e.impact === "High"), todayHigh = ev.filter((e) => e.impact === "High" && new Date(e.t).toDateString() === new Date().toDateString());
      const cd = (t) => { const m = Math.round((t - now) / 60000); return m < 60 ? m + " min" : m < 1440 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : Math.floor(m / 1440) + " j " + Math.floor((m % 1440) / 60) + " h"; };
      z.kpis.replaceChildren(kpi("Prochain événement fort", next ? cd(next.t) : "–", next ? `${next.cur} · ${next.title}` : "plus rien cette semaine", "warn"), kpi("Événements forts aujourd'hui", String(todayHigh.length), todayHigh.map((e) => e.title).slice(0, 2).join(", ") || "aucun"), kpi("Événements forts restants", String(ev.filter((e) => e.t > now && e.impact === "High").length), "cette semaine"));
      seg(z.imp, [["all", "Tous"], ["med", "Moyen et fort"], ["high", "Fort"]], imp, (k) => (imp = k));
      const curs = ["all", ...new Set(ev.map((e) => e.cur))]; seg(z.cur, curs.map((c) => [c, c === "all" ? "Toutes devises" : c]), cur, (k) => (cur = k));
      const list = ev.filter((e) => (imp === "all" || (imp === "med" ? e.impact !== "Low" : e.impact === "High")) && (cur === "all" || e.cur === cur));
      const days = {}; for (const e of list) (days[new Date(e.t).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })] ??= []).push(e);
      z.list.replaceChildren(...(list.length ? Object.entries(days).map(([d, es]) => h("div", { style: "margin-bottom:16px" }, h("h3", { style: "margin-bottom:8px;text-transform:capitalize" }, d), h("div", { class: "scroll" }, h("table", {}, h("tbody", {}, es.map((e) => h("tr", { style: e.t < now ? "opacity:.5" : "" }, h("td", { class: "mono", style: "width:64px" }, new Date(e.t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })), h("td", { style: "width:60px" }, h("span", { class: "chip cyan" }, e.cur)), h("td", { style: "width:78px" }, h("span", { class: "chip " + (IMP[e.impact]?.[1] || "neutral") }, IMP[e.impact]?.[0] || e.impact)),
        h("td", {}, e.title), h("td", { class: "r mono muted" }, e.forecast ? "prévu " + e.forecast : ""), h("td", { class: "r mono dim" }, e.previous ? "préc. " + e.previous : ""))))))) ) : [empty("Aucun événement avec ces filtres.")]));
    },
  };
})();

/* ---------- PROBABILITÉS ---------- */
App.views.odds = (() => {
  const z = {}; let cat = "all";
  return {
    title: () => ["Probabilités ", h("em", {}, "de marché")],
    sub: "Ce que l'argent réel parie sur les événements politiques, économiques et géopolitiques. Une cote qui bouge de plusieurs points en 24 h signale souvent une information avant qu'elle ne fasse les gros titres.",
    init(box) { z.seg = h("div", { class: "seg" }); z.mov = h("div", {}); z.tbl = h("div", { class: "scroll limited" }); box.append(h("div", { class: "toolbar" }, z.seg), panel("Cotes en mouvement", { sub: "variation sur 24 h, en points de probabilité" }, z.mov), panel("Événements les plus échangés", { sub: "hors sport" }, z.tbl)); },
    update(S) {
      const o = X().odds || { events: [], movers: [] }, cats = ["all", ...new Set(o.events.map((e) => e.cat))]; seg(z.seg, cats.map((c) => [c, c === "all" ? "Tout" : c]), cat, (k) => (cat = k));
      const mv = o.movers.filter((m) => cat === "all" || m.cat === cat).slice(0, 12);
      z.mov.replaceChildren(...(mv.length ? mv.map((m) => { const b = dbar(m.single ? m.title : m.q, m.single ? m.cat : m.title, Math.max(-1, Math.min(1, m.d1 * 2.5)), (m.d1 > 0 ? "+" : "") + (m.d1 * 100).toFixed(0) + " pts", () => window.open("https://polymarket.com/event/" + m.slug, "_blank", "noopener"), h("span", { class: "mono muted", style: "grid-column:2/4;font-size:.72rem" }, `désormais ${(m.p * 100).toFixed(0)} % · ${usd(m.vol)} échangés en 24 h`)); b.style.gridTemplateColumns = "minmax(140px,1.4fr) minmax(0,1fr) 84px"; return b; }) : [empty("Aucune cote n'a bougé de plus de 5 points.")]));
      const ev = o.events.filter((e) => cat === "all" || e.cat === cat);
      z.tbl.replaceChildren(sortableTable("odds", [{ t: "Événement", cell: (e) => h("span", {}, mkLink("https://polymarket.com/event/" + e.slug, e.title), " ", h("span", { class: "chip neutral" }, e.cat)) },
        { t: "Scénario principal", cell: (e) => h("span", { class: "muted" }, e.n > 1 ? e.markets[0].q : e.markets[0].yes || "Oui") }, { t: "Probabilité", sort: (e) => e.markets[0].p, cell: (e) => h("div", { style: "display:flex;gap:8px;align-items:center" }, h("div", { class: "bias", style: "min-width:70px" }, h("i", { class: "l", style: `width:${e.markets[0].p * 100}%;background:var(--cyan);box-shadow:0 0 8px var(--cyan)` })), h("span", { class: "mono" }, (e.markets[0].p * 100).toFixed(0) + " %")) },
        { t: "24 h", cls: "r", sort: (e) => e.markets[0].d1, cell: (e) => h("span", { class: "mono " + cls(Math.abs(e.markets[0].d1) < 0.005 ? 0 : e.markets[0].d1) }, (e.markets[0].d1 > 0 ? "+" : "") + (e.markets[0].d1 * 100).toFixed(0) + " pts") }, { t: "Volume 24 h", cls: "r", sort: (e) => e.vol, cell: (e) => h("span", { class: "mono" }, usd(e.vol)) }],
        ev, { rowKey: (e) => "od:" + e.id, defaultSort: { k: "Volume 24 h", dir: "desc" }, detail: (e) => h("div", { class: "feed" }, e.markets.map((m) => h("div", { class: "orow" }, h("span", {}, m.q), h("span", { class: "mono" }, (m.p * 100).toFixed(0) + " %  ", h("span", { class: cls(m.d1) }, (m.d1 > 0 ? "+" : "") + (m.d1 * 100).toFixed(0) + " pts"))))) }));
    },
  };
})();
