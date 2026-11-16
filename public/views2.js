"use strict";
/* Outils : flux en direct, liquidations, funding & OI, historique, calculateur de position. */

/* ---------- FLUX EN DIRECT ---------- */
App.views.flux = (() => {
  const z = {}; let lastT = 0, first = true, page = 0, q = "", win = 24;
  const PER = 60, sg = (e) => (e.kind === "open" || e.kind === "add" ? 1 : -1) * (e.side === "long" ? 1 : -1);
  const pass = (e) => (ui.flux.src === "all" || e.src === ui.flux.src) && (ui.flux.min === 0 || (e.src === "pm" ? e.notional >= ui.flux.min / 10 : e.notional >= ui.flux.min))
    && (!q || [e.name, e.addr, e.coin && coinName(e.coin), e.title, e.outcome].some((x) => x && String(x).toLowerCase().includes(q)));
  return {
    title: () => ["Flux ", h("em", {}, "en direct")],
    sub: "Chaque ouverture, renforcement, réduction ou fermeture de position des baleines suivies. Cliquez un nom pour voir son portefeuille, un actif ou un marché pour voir qui y est positionné.",
    init(box) {
      z.src = h("div", { class: "seg" }); z.min = h("div", { class: "seg" }); z.win = h("div", { class: "seg" }); z.stats = h("div", { class: "fstats" });
      z.assets = h("div", { class: "astrip" }); z.mkts = h("div", { class: "astrip" }); z.list = h("div", { class: "feed flist" }); z.pager = h("div", { class: "pager" }); z.count = h("span", { class: "muted", style: "font-size:.8rem" });
      z.search = h("input", { type: "search", class: "search", placeholder: "Filtrer : nom, actif, marché…", "aria-label": "Filtrer le flux", oninput: (e) => { q = e.target.value.trim().toLowerCase(); page = 0; this.update(App.S); } });
      z.sound = h("button", { class: "btn", type: "button", onclick: () => { ui.flux.sound = !ui.flux.sound; if (ui.flux.sound) beep(); save(); this.btns(); } }, "Son");
      z.notif = h("button", { class: "btn", type: "button", onclick: async () => { if (!("Notification" in window)) return; if (!ui.flux.notif) { const p = await Notification.requestPermission(); ui.flux.notif = p === "granted"; } else ui.flux.notif = false; save(); this.btns(); } }, "Notifications");
      box.append(z.stats,
        panel("Actifs les plus agités", { sub: "flux net des baleines Hyperliquid · clic pour voir qui est positionné", tools: z.win }, z.assets),
        panel("Marchés Polymarket les plus agités", { sub: "clic pour voir qui est positionné" }, z.mkts),
        h("section", { class: "panel" }, h("div", { class: "head" }, h("h2", {}, "Tous les mouvements"), z.count, h("div", { class: "sp toolbar" }, z.sound, z.notif)), h("div", { class: "body" }, h("div", { class: "toolbar", style: "margin-bottom:12px" }, z.search, z.src, z.min), z.list, z.pager)));
    },
    btns() { z.sound.classList.toggle("on", ui.flux.sound); z.notif.classList.toggle("on", ui.flux.notif); z.sound.textContent = ui.flux.sound ? "Son activé" : "Son"; z.notif.textContent = ui.flux.notif ? "Notifications activées" : "Notifications"; },
    update(S) {
      this.btns();
      seg(z.src, [["all", "Tout"], ["hl", "Hyperliquid"], ["pm", "Polymarket"]], ui.flux.src, (k) => { ui.flux.src = k; page = 0; });
      seg(z.min, [[0, "Tous"], [50000, "≥ 50 k$"], [250000, "≥ 250 k$"], [1000000, "≥ 1 M$"]], ui.flux.min, (k) => { ui.flux.min = k; page = 0; });
      seg(z.win, [[1, "1 h"], [6, "6 h"], [24, "24 h"]], win, (k) => (win = k));
      const recent = S.events.filter((e) => Date.now() - e.t < win * 3600e3), hl = recent.filter((e) => e.src === "hl"), h1 = S.events.filter((e) => Date.now() - e.t < 3600e3);
      const sumIn = (side) => h1.filter((e) => e.src === "hl" && e.side === side && (e.kind === "open" || e.kind === "add")).reduce((s, e) => s + Math.abs(e.delta), 0);
      const stat = (l, v, c) => h("div", { class: "fstat" }, h("span", { class: "l" }, l), h("b", { class: "mono " + (c || "") }, v));
      z.stats.replaceChildren(stat("Mouvements (1 h)", String(h1.length)), stat("Longs ajoutés (1 h)", usd(sumIn("long")), "up"), stat("Shorts ajoutés (1 h)", usd(sumIn("short")), "down"), stat("Mouvements (" + win + " h)", String(recent.length)), stat("Au total", String(S.events.length)));
      // actifs
      const by = {}; for (const e of hl) { const x = (by[e.coin] ??= { coin: e.coin, net: 0, gross: 0, n: 0, l: 0, s: 0 }); const v = Math.abs(e.delta); x.net += sg(e) * v; x.gross += v; x.n++; sg(e) > 0 ? (x.l += v) : (x.s += v); }
      const top = Object.values(by).sort((a, b) => b.gross - a.gross).slice(0, 10), mk = marketMap();
      z.assets.replaceChildren(...(top.length ? top.map((x) => h("button", { type: "button", class: "acard", onclick: () => Drawer.asset(x.coin) }, h("div", { class: "row" }, h("b", {}, coinName(x.coin)), mk[x.coin] ? h("span", { class: "mono " + cls(mk[x.coin].chg) }, spct(mk[x.coin].chg, 1)) : null),
        h("div", { class: "mono " + cls(x.net), style: "font-size:1.05rem" }, signed(x.net)), bias(x.l, x.s), h("div", { class: "dim", style: "font-size:.72rem" }, `${x.n} mouvement${x.n > 1 ? "s" : ""} · ${usd(x.gross)} échangés`))) : [empty("Aucun mouvement Hyperliquid sur la période.")]));
      const pmBy = {}; for (const e of recent.filter((x) => x.src === "pm")) { const x = (pmBy[e.title] ??= { title: e.title, slug: e.slug, n: 0, v: 0, outs: {} }); x.n++; x.v += Math.abs(e.delta); x.outs[e.outcome] = (x.outs[e.outcome] || 0) + (e.kind === "open" || e.kind === "add" ? 1 : -1) * Math.abs(e.delta); }
      const pmTop = Object.values(pmBy).sort((a, b) => b.v - a.v).slice(0, 8);
      z.mkts.replaceChildren(...(pmTop.length ? pmTop.map((x) => { const best = Object.entries(x.outs).sort((a, b) => b[1] - a[1])[0]; return h("button", { type: "button", class: "acard wide", onclick: () => Drawer.market(x.title, x.slug) }, h("b", { style: "font-size:.82rem" }, x.title), h("div", { class: "row" }, best ? h("span", { class: "chip " + (best[1] >= 0 ? "up" : "down") }, (best[1] >= 0 ? "achats sur « " : "ventes sur « ") + best[0] + " »") : null, h("span", { class: "mono dim" }, `${x.n} mvt · ${usd(x.v)}`))); }) : [empty("Aucun mouvement Polymarket sur la période.")]));
      // liste paginée
      const list = S.events.filter(pass), pages = Math.max(1, Math.ceil(list.length / PER)); if (page >= pages) page = pages - 1;
      z.count.textContent = `${list.length} mouvement${list.length > 1 ? "s" : ""}`;
      z.list.replaceChildren(...(list.length ? list.slice(page * PER, page * PER + PER).map((e) => evRow(e, !first && e.t > lastT, true)) : [empty("Rien à afficher avec ces filtres. Les positions Hyperliquid sont relevées toutes les 45 s, Polymarket toutes les 10 à 20 min.")]));
      const go = (p) => { page = p; this.update(App.S); z.list.scrollIntoView({ behavior: "smooth", block: "start" }); };
      const nums = [...new Set([0, page - 2, page - 1, page, page + 1, page + 2, pages - 1])].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
      z.pager.replaceChildren(...(pages > 1 ? [h("button", { class: "btn", type: "button", disabled: page === 0 ? "" : null, onclick: () => go(page - 1) }, "← Précédent"), ...nums.map((p) => h("button", { class: "btn" + (p === page ? " on" : ""), type: "button", "aria-current": p === page ? "page" : null, onclick: () => go(p) }, String(p + 1))), h("button", { class: "btn", type: "button", disabled: page >= pages - 1 ? "" : null, onclick: () => go(page + 1) }, "Suivant →")] : []));
      if (S.events.length) lastT = S.events[0].t; first = false;
    },
  };
})();

/* ---------- LIQUIDATIONS ---------- */
App.views.liq = (() => {
  const z = {};
  return {
    title: () => ["Carte des ", h("em", {}, "liquidations")],
    sub: "Où se trouvent les prix de liquidation des positions de l'échantillon, autour du cours actuel. Les zones denses peuvent attirer le prix ou provoquer des cascades.",
    init(box) {
      z.coin = h("div", { class: "seg" }); z.range = h("div", { class: "seg" }); z.kpis = h("div", { class: "kpis" }); z.chart = h("div", {}); z.lev = h("div", {});
      box.append(h("div", { class: "toolbar" }, z.coin, z.range), z.kpis, panel("Répartition des liquidations", { sub: "rose : longs liquidés sous le prix · cyan : shorts liquidés au-dessus" }, z.chart, h("div", { class: "legend", style: "margin-top:10px" }, h("span", {}, h("i", { style: "background:var(--rose)" }), "Longs liquidés"), h("span", {}, h("i", { style: "background:var(--cyan)" }), "Shorts liquidés"), h("span", {}, h("i", { style: "background:var(--amber)" }), "Prix actuel")), h("p", { class: "disclaimer", style: "margin:10px 0 0" }, "Estimation à partir du prix de liquidation que renvoie Hyperliquid pour chaque position de l'échantillon. En marge croisée, il dépend du reste du compte et bouge avec lui. Les liquidations à plus de 2× ou moins de 0,3× le prix sont ignorées.")), panel("Niveaux les plus denses", {}, z.lev));
    },
    update(S) {
      if (!S.liq.length) { z.chart.replaceChildren(empty("Pas encore de données de liquidation.")); return; }
      if (!S.liq.some((l) => l.coin === ui.liqCoin)) ui.liqCoin = S.liq[0].coin;
      seg(z.coin, S.liq.map((l) => [l.coin, coinName(l.coin)]), ui.liqCoin, (k) => (ui.liqCoin = k)); seg(z.range, [[0.1, "±10 %"], [0.2, "±20 %"], [0.3, "±30 %"]], ui.liqRange, (k) => (ui.liqRange = k));
      const d = S.liq.find((l) => l.coin === ui.liqCoin), r = ui.liqRange;
      const lo = d.mark * (1 - r), hi = d.mark * (1 + r), inR = d.list.filter((x) => x.px >= lo && x.px < hi), LL = inR.filter((x) => x.side === "long").reduce((s, x) => s + x.n, 0), SS = inR.filter((x) => x.side === "short").reduce((s, x) => s + x.n, 0);
      z.kpis.replaceChildren(kpi("Prix actuel", px(d.mark), coinName(d.coin)), kpi(`Longs liquidables (−${r * 100} %)`, usd(LL), `${inR.filter((x) => x.side === "long").length} positions`, "down"), kpi(`Shorts liquidables (+${r * 100} %)`, usd(SS), `${inR.filter((x) => x.side === "short").length} positions`, ""), kpi("Déséquilibre", LL + SS ? spct((SS - LL) / (LL + SS)) : "–", SS > LL ? "plus de shorts exposés à un squeeze haussier" : "plus de longs exposés à une chute"));
      Ch.liqHist(z.chart, d, { range: r, fmtPx: px, fmtN: (v) => usd(v), height: 300 });
      const step = d.mark * 0.01, bins = new Map(); for (const x of inR) { const k = Math.round((x.px - d.mark) / step); const b = bins.get(k) || { k, n: 0, long: 0, short: 0 }; b.n += x.n; b[x.side] += x.n; bins.set(k, b); }
      const top = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 8);
      z.lev.replaceChildren(top.length ? sortableTable("liqlv", [{ t: "Zone", cell: (b) => h("span", { class: "mono" }, px(d.mark + b.k * step) + ` (${b.k > 0 ? "+" : ""}${b.k} %)`) }, { t: "Type", cell: (b) => h("span", { class: "chip " + (b.long > b.short ? "down" : "cyan") }, b.long > b.short ? "longs liquidés" : "shorts liquidés") },
        { t: "Notionnel", cls: "r", sort: (b) => b.n, cell: (b) => h("span", { class: "mono" }, usd(b.n)) }], top, { defaultSort: { k: "Notionnel", dir: "desc" } }) : empty("Aucune liquidation dans cette fourchette."));
    },
  };
})();

/* ---------- FUNDING & OPEN INTEREST ---------- */
App.views.funding = (() => {
  const z = {};
  return {
    title: () => ["Funding & ", h("em", {}, "open interest")],
    sub: "Qui paie pour garder sa position, combien d'argent est engagé, et où les baleines sont du même côté que la foule. Un funding extrême avec des baleines du même côté signale un trade encombré.",
    init(box) { z.sc = h("div", {}); z.tbl = h("div", { class: "scroll limited" }); box.append(panel("Funding contre biais des baleines", { sub: "taille de bulle = open interest · clic pour ouvrir le calculateur" }, z.sc, h("p", { class: "disclaimer", style: "margin:10px 0 0" }, "Horizontal : funding annualisé (positif = les longs paient les shorts). Vertical : biais net des comptes de l'échantillon sur l'actif (+100 % = tous long).")), panel("Marchés", { sub: "triés par open interest" }, z.tbl)); },
    update(S) {
      const cb = Object.fromEntries(S.hl.coins.map((c) => [c.coin, c])), mk = S.hl.markets.filter((m) => m.oi >= 5e6);
      const pts = S.hl.coins.filter((c) => S.hl.markets.find((m) => m.coin === c.coin) && c.gross >= 1e6).map((c) => { const m = S.hl.markets.find((x) => x.coin === c.coin), sk = (c.longN - c.shortN) / (c.gross || 1), f = fundingAnn(m);
        return { x: f, y: sk, r: m.oi, label: coinName(c.coin).slice(0, 4), coin: c.coin, tip: [h("b", {}, coinName(c.coin)), `Funding : ${spct(f, 1)}/an`, `Baleines : ${spct(sk)} (${c.nLong} L / ${c.nShort} S)`, `OI : ${usd(m.oi)}`] }; });
      Ch.scatter(z.sc, pts, { xLabel: "funding annualisé", yLabel: "biais des baleines", xFmt: (v) => spct(v), yFmt: (v) => spct(v), xMax: 0.4, onClick: (p) => { ui.calc.coin = p.coin; save(); location.hash = "calc"; } });
      const flag = (m, c) => { const f = fundingAnn(m), sk = c ? (c.longN - c.shortN) / (c.gross || 1) : 0; if (f > 0.25 && sk > 0.3) return ["warn", "longs encombrés"]; if (f < -0.25 && sk < -0.3) return ["warn", "shorts encombrés"]; if (f > 0.25) return ["neutral", "longs paient"]; if (f < -0.25) return ["neutral", "shorts paient"]; return null; };
      z.tbl.replaceChildren(sortableTable("fund", [{ t: "Actif", cell: (m) => h("b", {}, coinName(m.coin)) }, { t: "Prix", cls: "r", cell: (m) => h("span", { class: "mono" }, px(m.mark)) }, { t: "24 h", cls: "r", sort: (m) => m.chg, cell: (m) => h("span", { class: "mono " + cls(m.chg) }, spct(m.chg, 1)) },
        { t: "Funding / an", cls: "r", sort: fundingAnn, cell: (m) => h("span", { class: "mono " + (Math.abs(fundingAnn(m)) > 0.25 ? "warn" : "") }, spct(fundingAnn(m), 1)) }, { t: "Open interest", cls: "r", sort: (m) => m.oi, cell: (m) => h("span", { class: "mono" }, usd(m.oi)) },
        { t: "Volume 24 h", cls: "r", sort: (m) => m.vol, cell: (m) => h("span", { class: "mono muted" }, usd(m.vol)) }, { t: "Baleines", sort: (m) => (cb[m.coin] ? (cb[m.coin].longN - cb[m.coin].shortN) / (cb[m.coin].gross || 1) : -2), cell: (m) => cb[m.coin] ? bias(cb[m.coin].longN, cb[m.coin].shortN) : h("span", { class: "dim" }, "–") },
        { t: "Lecture", cell: (m) => { const f = flag(m, cb[m.coin]); return f ? h("span", { class: "chip " + f[0] }, f[1]) : null; } }], mk, { defaultSort: { k: "Open interest", dir: "desc" } }));
    },
  };
})();

/* ---------- HISTORIQUE ---------- */
App.views.histo = (() => {
  const z = {}, PAL = ["#22e6ff", "#2bffb0", "#ff3d86", "#ffc247", "#9a6bff", "#ff8a3d", "#5fa8ff", "#e45bff"];
  const mini = (v) => v == null ? h("span", { class: "dim" }, "–") : h("div", { style: "display:flex;align-items:center;gap:8px" }, h("div", { class: "gauge-mini", style: "position:relative;width:90px;height:8px;background:rgba(255,255,255,.06);border-radius:4px" }, h("i", { style: `position:absolute;top:0;bottom:0;border-radius:4px;left:${v >= 0 ? 50 : 50 - Math.abs(v) * 50}%;width:${Math.abs(v) * 50}%;background:${colOf(v)};box-shadow:0 0 8px ${colOf(v)}` })), h("span", { class: "mono " + toneOf(v) }, spct(v)));
  return {
    title: () => ["Historique & ", h("em", {}, "momentum")],
    sub: "Comment le sentiment évolue dans le temps, et si les meilleurs comptes pensent comme la foule. Un point est enregistré chaque minute et conservé après redémarrage.",
    init(box) {
      z.range = h("div", { class: "seg" }); z.chips = h("div", { class: "seg" }); z.chart = h("div", {}); z.vs = h("div", { class: "scroll" }); z.info = h("span", { class: "muted" });
      box.append(h("div", { class: "toolbar" }, z.range, z.chips), panel("Score de sentiment", { sub: "", tools: z.info }, z.chart), panel("Meilleurs comptes contre la foule", { sub: "top 20 par ROI du mois contre les 80 autres" }, z.vs, h("p", { class: "disclaimer", style: "margin:10px 0 0" }, "Un écart marqué est intéressant : quand les meilleurs comptes sont plus baissiers (ou haussiers) que le reste de l'échantillon, c'est un signal de divergence à surveiller.")));
    },
    update(S) {
      seg(z.range, [[1, "1 h"], [6, "6 h"], [24, "24 h"], [9999, "Tout"]], ui.histRange, (k) => (ui.histRange = k));
      const topics = S.sentiment.map((s) => s.topic);
      z.chips.replaceChildren(h("button", { type: "button", "aria-pressed": String(ui.histTopics.includes("__g")), onclick: () => { tog("__g"); } }, "Indice global"), ...topics.slice(0, 10).map((t) => h("button", { type: "button", "aria-pressed": String(ui.histTopics.includes(t)), onclick: () => tog(t) }, S.sentiment.find((s) => s.topic === t).name.split(" ")[0])));
      function tog(t) { ui.histTopics = ui.histTopics.includes(t) ? ui.histTopics.filter((x) => x !== t) : [...ui.histTopics, t]; save(); App.refresh(); }
      const hs = S.history.filter((p) => Date.now() - p.t < ui.histRange * 3600e3), series = []; let i = 0;
      if (ui.histTopics.includes("__g")) series.push({ name: "Indice global", color: "#ffffff", pts: hs.map((p) => [p.t, p.g]), w: 2.6, fill: true });
      for (const t of ui.histTopics.filter((x) => x !== "__g")) { const nm = S.sentiment.find((s) => s.topic === t)?.name || t; series.push({ name: nm, color: PAL[i++ % PAL.length], pts: hs.filter((p) => p.s[t] != null).map((p) => [p.t, p.s[t]]) }); }
      z.info.textContent = `${hs.length} points · depuis ${S.history.length ? new Date(S.history[0].t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–"}`;
      Ch.line(z.chart, series.length ? series : [{ name: "—", color: "#fff", pts: [] }], { height: 320, auto: true, timeFmt: ui.histRange <= 24 ? undefined : (t) => new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) });
      const rows = S.sentiment.filter((s) => s.elite && s.crowd).map((s) => ({ ...s, gap: s.elite.score - s.crowd.score }));
      z.vs.replaceChildren(rows.length ? sortableTable("elite", [{ t: "Actif", cell: (s) => h("b", {}, s.name) }, { t: "Top 20", sort: (s) => s.elite.score, cell: (s) => mini(s.elite.score) }, { t: "Foule", sort: (s) => s.crowd.score, cell: (s) => mini(s.crowd.score) },
        { t: "Écart", cls: "r", sort: (s) => Math.abs(s.gap), cell: (s) => h("span", { class: "mono " + (Math.abs(s.gap) >= 0.5 ? "warn" : "muted") }, (s.gap > 0 ? "+" : "") + (s.gap * 100).toFixed(0) + " pts") },
        { t: "Lecture", cell: (s) => Math.abs(s.gap) < 0.3 ? h("span", { class: "muted" }, "même avis") : h("span", { class: "chip warn" }, s.gap > 0 ? "les meilleurs sont plus haussiers" : "les meilleurs sont plus baissiers") }], rows, { defaultSort: { k: "Écart", dir: "desc" } }) : empty("Pas assez de comptes pour comparer."));
    },
  };
})();

/* ---------- CALCULATEUR ---------- */
App.views.calc = (() => {
  const z = {}; let S0 = null;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  function field(id, lab, input) { return h("div", { class: "field" }, h("label", { for: id }, lab), input); }
  function num(id, key, step) { const i = h("input", { type: "number", id, step: step || "any", value: ui.calc[key], inputmode: "decimal" }); i.addEventListener("input", () => { ui.calc[key] = i.value === "" ? 0 : Number(i.value); save(); compute(); }); return i; }
  function compute() {
    if (!S0) return; const c = ui.calc, mk = marketMap(), m = mk[c.coin]; if (!m) return;
    const entry = Number(z.entry.value) > 0 ? Number(z.entry.value) : m.mark, dir = c.side === "long" ? 1 : -1, E = c.equity, riskUsd = E * c.risk / 100;
    const dist = c.stop / 100, stopPx = entry * (1 - dir * dist), tpPx = entry * (1 + dir * (c.tp / 100)), notional = dist > 0 ? riskUsd / dist : 0, units = notional / entry;
    const lev = c.lev > 0 ? c.lev : Math.max(1, notional / E), mmr = 0.5 / m.maxLev, margin = 1 / lev - mmr;
    const liq = dir > 0 ? entry * (1 - margin) / (1 - mmr) : entry * (1 + margin) / (1 + mmr), liqDist = Math.abs(liq - entry) / entry;
    const fees = notional * 0.00045 * 2, fund = notional * m.funding * 24 * dir, rr = dist > 0 ? c.tp / c.stop : 0, gain = notional * (c.tp / 100);
    z.out.replaceChildren(kpi("Risque", usd(riskUsd, 0), `${c.risk} % du capital`, "down"), kpi("Taille de position", usd(notional), `${units.toFixed(units < 1 ? 4 : 2)} ${coinName(c.coin)}`), kpi("Levier requis", lev.toFixed(1) + "×", `max ${m.maxLev}× sur ${coinName(c.coin)}`), kpi("Prix d'entrée", px(entry), c.side === "long" ? "achat" : "vente"),
      kpi("Stop", px(stopPx), spct(-dir * dist, 1), "down"), kpi("Objectif", px(tpPx), spct(dir * c.tp / 100, 1), "up"), kpi("Gain / risque", rr.toFixed(2) + " R", `gain visé ${usd(gain, 0)}`, rr >= 2 ? "up" : rr < 1 ? "down" : ""), kpi("Liquidation estimée", px(liq), spct(-dir * liqDist, 1) + " du prix"),
      kpi("Frais aller-retour", usd(fees, 0), "0,045 % × 2 (taux taker de base)"), kpi("Funding sur 24 h", (fund > 0 ? "−" : "+") + usd(Math.abs(fund), 0), `${spct(fundingAnn(m), 1)}/an · ${fund > 0 ? "vous payez" : "vous recevez"}`));
    const chk = [];
    chk.push(lev <= m.maxLev ? ["ok", `Levier ${lev.toFixed(1)}× dans la limite de ${m.maxLev}×.`] : ["ko", `Levier ${lev.toFixed(1)}× au-dessus du maximum ${m.maxLev}×. Réduisez le risque ou élargissez le stop.`]);
    chk.push(dist < liqDist * 0.7 ? ["ok", `Le stop (${spct(dist, 1).replace("+", "")}) tombe bien avant la liquidation (${spct(liqDist, 1).replace("+", "")}).`] : ["ko", "Le stop est trop proche de la liquidation : vous seriez liquidé avant d'être stoppé."]);
    chk.push(rr >= 2 ? ["ok", `Ratio gain / risque de ${rr.toFixed(1)} R.`] : rr >= 1 ? ["w", `Ratio gain / risque de ${rr.toFixed(1)} R : correct mais mince.`] : ["ko", `Ratio gain / risque de ${rr.toFixed(1)} R : inférieur à 1.`]);
    const cost = (fees + Math.max(0, fund)) / Math.max(1, riskUsd); chk.push(cost < 0.1 ? ["ok", "Frais et funding négligeables face au risque."] : ["w", `Frais et funding pèsent ${(cost * 100).toFixed(0)} % du risque.`]);
    const pos = S0.hl.accounts.flatMap((a) => a.positions.filter((p) => p.coin === c.coin && p.notional >= 10000)), nL = pos.filter((p) => p.side === "long").length, nS = pos.length - nL, mine = c.side === "long" ? nL : nS;
    if (pos.length >= 4) chk.push(mine / pos.length >= 0.5 ? ["ok", `${mine} baleines sur ${pos.length} sont du même côté que vous.`] : mine / pos.length >= 0.3 ? ["w", `Seulement ${mine} baleines sur ${pos.length} sont de votre côté.`] : ["ko", `Vous allez à contre-courant : ${mine} baleines sur ${pos.length} seulement dans votre sens.`]);
    z.checks.replaceChildren(...chk.map(([k, t]) => h("div", { class: "check " + k }, h("span", {}, k === "ok" ? "✓" : k === "ko" ? "✕" : "!"), t)));
    const wavg = (arr) => { const t = arr.reduce((s, p) => s + p.notional, 0); return t ? arr.reduce((s, p) => s + p.entry * p.notional, 0) / t : 0; }, L = pos.filter((p) => p.side === "long"), Sx = pos.filter((p) => p.side === "short");
    z.bench.replaceChildren(pos.length ? h("div", { class: "out" }, kpi("Baleines positionnées", String(pos.length), `${nL} long · ${nS} short`), kpi("Levier médian", med(pos.map((p) => +p.lev || 0)).toFixed(1) + "×", "sur cet actif"), kpi("Entrée moyenne des longs", L.length ? px(wavg(L)) : "–", L.length ? spct(m.mark / wavg(L) - 1, 1) + " vs prix actuel" : ""), kpi("Entrée moyenne des shorts", Sx.length ? px(wavg(Sx)) : "–", Sx.length ? spct(m.mark / wavg(Sx) - 1, 1) + " vs prix actuel" : "")) : empty("Aucune baleine de l'échantillon sur cet actif."));
    z.live.textContent = `Prix live ${px(m.mark)} · ${spct(m.chg, 1)} sur 24 h · funding ${spct(fundingAnn(m), 1)}/an · OI ${usd(m.oi)}`;
  }
  return {
    title: () => ["Calculateur de ", h("em", {}, "position")],
    sub: "Dimensionne une position à partir du risque que vous acceptez, avec le prix en direct, la liquidation estimée, les frais, le funding et le comportement des baleines sur le même actif.",
    init(box) {
      const c = ui.calc;
      z.coin = h("select", { id: "c-coin", onchange: (e) => { c.coin = e.target.value; z.entry.value = ""; save(); compute(); } });
      z.side = h("div", { class: "seg" }, ["long", "short"].map((s) => h("button", { type: "button", "data-s": s, "aria-pressed": String(c.side === s), onclick: () => { c.side = s; save(); for (const b of z.side.children) b.setAttribute("aria-pressed", String(b.dataset.s === s)); compute(); } }, s === "long" ? "Long" : "Short")));
      z.entry = h("input", { type: "number", id: "c-entry", step: "any", placeholder: "prix live", inputmode: "decimal" }); z.entry.addEventListener("input", compute);
      z.out = h("div", { class: "out" }); z.checks = h("div", { style: "display:flex;flex-direction:column;gap:8px" }); z.bench = h("div", {}); z.live = h("span", { class: "mono muted" });
      const quick = h("div", { class: "seg" }, [0.5, 1, 2, 5].map((v) => h("button", { type: "button", onclick: () => { c.stop = v; z.stop.value = v; save(); compute(); } }, "stop " + v + " %")));
      z.stop = num("c-stop", "stop", "0.1");
      box.append(panel("Paramètres", { tools: z.live }, h("div", { class: "form" }, field("c-coin", "Actif", z.coin), field("", "Sens", z.side), field("c-eq", "Capital ($)", num("c-eq", "equity", "1000")), field("c-risk", "Risque (% du capital)", num("c-risk", "risk", "0.1")), field("c-stop", "Stop (% du prix)", z.stop), field("c-tp", "Objectif (% du prix)", num("c-tp", "tp", "0.1")), field("c-lev", "Levier imposé (0 = automatique)", num("c-lev", "lev", "1")), field("c-entry", "Prix d'entrée (vide = prix live)", z.entry)), h("div", { style: "margin-top:14px" }, quick)),
        panel("Résultat", {}, z.out), h("div", { class: "grid g2" }, panel("Vérifications", {}, z.checks), panel("Ce que font les baleines sur cet actif", {}, z.bench)),
        h("p", { class: "disclaimer" }, "Outil de calcul, pas un conseil d'investissement. Les frais utilisent le taux taker de base, la liquidation est estimée en marge isolée avec la formule de Hyperliquid (taux de maintenance = 1 / (2 × levier max)). Vérifiez toujours sur la plateforme."));
    },
    update(S) {
      S0 = S; const mk = [...S.hl.markets].sort((a, b) => b.oi - a.oi).slice(0, 80), cur = ui.calc.coin;
      if (!mk.some((m) => m.coin === cur) && mk.length) ui.calc.coin = mk[0].coin;
      if (z.coin.options.length !== mk.length) z.coin.replaceChildren(...mk.map((m) => h("option", { value: m.coin }, coinName(m.coin))));
      z.coin.value = ui.calc.coin; compute();
    },
  };
})();
