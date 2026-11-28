"use strict";
/* Noyau : état, routeur, formats, tableaux. Les vues s'enregistrent dans App.views. */
const h = Ch.el, $ = (id) => document.getElementById(id);
const App = { S: null, SNAP: window.__SNAPSHOT__ || null, views: {}, inited: {}, cur: null, seenEv: 0, firstState: true };
const ui = { sort: {}, open: new Set(), hlWin: "month", pmCat: "OVERALL", pmPer: "MONTH", pmMktCat: "all", sentGroup: "all", flux: { src: "all", min: 250000, sound: false, notif: false },
  liqCoin: "BTC", liqRange: 0.2, histRange: 6, histTopics: ["BTC", "ETH", "OIL", "GOLD"], calc: { coin: "BTC", side: "long", equity: 100000, risk: 1, stop: 2, tp: 4, lev: 0 } };
try { const s = JSON.parse(localStorage.getItem("wc-ui2") || "{}"); for (const k of Object.keys(s)) if (k !== "open") ui[k] = typeof ui[k] === "object" && !Array.isArray(ui[k]) ? { ...ui[k], ...s[k] } : s[k]; } catch {}
const save = () => { try { localStorage.setItem("wc-ui2", JSON.stringify({ ...ui, open: [] })); } catch {} };

/* ---------- formats ---------- */
const usd = (n, d = 1) => { const a = Math.abs(n), s = n < 0 ? "−" : ""; if (a >= 999500 && a < 1e6) return s + "$1.0 M"; return s + "$" + (a >= 1e12 ? (a / 1e12).toFixed(2) + " k Md" : a >= 1e9 ? (a / 1e9).toFixed(d) + " Md" : a >= 1e6 ? (a / 1e6).toFixed(d) + " M" : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e5 ? 0 : d) + " k" : a.toFixed(0)); };
const signed = (n) => (n > 0 ? "+" : "") + usd(n);
const pct = (x, d = 0) => (x * 100).toFixed(d) + " %";
const spct = (x, d = 0) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x * 100).toFixed(d) + " %";
const sh = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "muted");
const px = (v) => (v >= 1000 ? v.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : v >= 1 ? v.toFixed(3) : String(+v.toPrecision(4)));
const coinName = (c) => c.replace("xyz:", "");
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + " s" : s < 3600 ? Math.round(s / 60) + " min" : Math.round(s / 3600) + " h"; };
const mkLink = (href, text, c) => h("a", { href, target: "_blank", rel: "noopener noreferrer", class: c, onclick: (e) => e.stopPropagation() }, text);
const hlLink = (a) => mkLink("https://hypurrscan.io/address/" + a, "↗");
const pmLink = (a) => mkLink("https://polymarket.com/profile/" + a, "↗");
// nom cliquable : ouvre la fiche du portefeuille (la flèche ↗ ouvre le site externe)
const who = (w, link) => { const src = link === pmLink ? "pm" : "hl", named = w.name && !/^0x/i.test(w.name);
  return h("span", {}, h("button", { type: "button", class: "lnk", title: "Voir le portefeuille", onclick: (e) => { e.stopPropagation(); Drawer.wallet(w.addr, src, w.name); } }, named ? h("span", { class: "name" }, w.name) : h("span", { class: "addr" }, sh(w.addr))), named ? h("span", { class: "addr" }, " " + sh(w.addr)) : null, " ", link(w.addr)); };
const label = (s) => (s >= 0.6 ? "Très haussier" : s >= 0.25 ? "Haussier" : s <= -0.6 ? "Très baissier" : s <= -0.25 ? "Baissier" : "Neutre");
const toneOf = (s) => (s >= 0.25 ? "up" : s <= -0.25 ? "down" : "muted");
const colOf = (s) => (s >= 0.25 ? Ch.C.up : s <= -0.25 ? Ch.C.down : Ch.C.amber);

/* ---------- briques ---------- */
function seg(el, items, cur, on) {
  el.replaceChildren(...items.map(([k, lab]) => h("button", { type: "button", "aria-pressed": String(k === cur), onclick: () => { on(k); save(); App.refresh(); } }, lab)));
}
function bias(l, s) { const t = l + s || 1; return h("div", { class: "bias", title: `Long ${usd(l)} · Short ${usd(s)}` }, h("i", { class: "l", style: `width:${(l / t) * 100}%` }), h("i", { class: "s", style: `width:${(s / t) * 100}%` })); }
function dbar(name, sub, score, valueText, onclick, extra) {
  const w = Math.min(1, Math.abs(score)) * 50, c = score >= 0 ? "var(--mint)" : "var(--rose)";
  return h("button", { class: "dbar", type: "button", onclick, title: valueText },
    h("div", { class: "n" }, name, sub ? h("small", {}, sub) : null),
    h("div", { class: "t" }, h("i", { style: `left:${score >= 0 ? 50 : 50 - w}%;width:${w}%;background:${c};box-shadow:0 0 14px ${c}` })),
    h("div", { class: "mono " + toneOf(score) }, valueText), extra);
}
// Panneau : titre, sous-titre sur une ligne (texte complet au survol), outils à droite ; la note de méthode est un tiroir fermé.
function panel(title, { sub, tools, noteText } = {}, ...body) {
  const head = h("div", { class: "head" }, h("h2", {}, title), sub ? h("span", { class: "muted", title: typeof sub === "string" ? sub : null }, sub) : null, tools ? h("div", { class: "sp" }, tools) : null);
  return h("section", { class: "panel" }, head, h("div", { class: "body" }, body),
    noteText ? h("details", { class: "note" }, h("summary", {}, "Méthode et précisions"), h("div", {}, noteText)) : null);
}
// Badges communs à toutes les pages : sens, division, flux, source, statut
const TAG = { long: ["LONG", "up"], short: ["SHORT", "down"], D1: ["D1", "neutral"], D2: ["D2", "cyan"], D3: ["D3", "up"], eps: ["ε", "cyan"], inf: ["∞", "violet"],
  x: ["X", "neutral"], arxiv: ["arXiv", "violet"], rss: ["RSS", "warn"], mutation: ["Gen-2", "violet"], hl: ["Hyperliquid", "cyan"], pm: ["Polymarket", "violet"] };
const tag = (k, text, title) => { const [t, c] = TAG[k] || [k, "neutral"]; return h("span", { class: "chip " + c, title: title || null }, text || t); };
// Tiroir fermé par défaut (détails techniques, JSON, journaux)
const drawer = (summary, ...body) => h("details", { class: "fold" }, h("summary", {}, summary), h("div", { class: "in" }, ...body));
function kpi(l, v, s, tone) { const e = h("div", { class: "v " + (tone || "") }, v); return h("div", { class: "kpi" }, h("div", { class: "l" }, l), e, s ? h("div", { class: "s" }, s) : null); }
function empty(msg) { return h("div", { class: "empty" }, msg); }

/* tableau triable : cols = [{t, cls, sort:(row)=>valeur, cell:(row)=>noeud}] ; clé de tri stockée dans ui.sort[id] */
function sortableTable(id, cols, rows, { rowKey, detail, colspan, defaultSort } = {}) {
  const st = ui.sort[id] || defaultSort || null, data = [...rows];
  if (st) { const c = cols.find((x) => x.t === st.k); if (c?.sort) data.sort((a, b) => (c.sort(a) - c.sort(b)) * (st.dir === "asc" ? 1 : -1)); }
  const head = h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: (c.cls || "") + (c.sort ? " sortable" : ""), scope: "col", "aria-sort": st?.k === c.t ? (st.dir === "asc" ? "ascending" : "descending") : null,
    onclick: c.sort ? () => { const cur = ui.sort[id] || defaultSort; ui.sort[id] = { k: c.t, dir: cur?.k === c.t && cur.dir === "desc" ? "asc" : "desc" }; save(); App.refresh(); } : null }, c.t + (st?.k === c.t ? (st.dir === "asc" ? " ▲" : " ▼") : "")))));
  const body = h("tbody", {});
  data.forEach((r, i) => {
    const tds = cols.map((c) => h("td", { class: c.cls || "" }, c.cell(r, i)));
    if (!detail) return body.append(h("tr", {}, tds));
    const key = rowKey(r), open = ui.open.has(key);
    const tr = h("tr", { class: "row" + (open ? " open" : ""), tabindex: "0", "aria-expanded": String(open),
      onclick: () => { open ? ui.open.delete(key) : ui.open.add(key); App.refresh(); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tr.click(); } } }, tds);
    body.append(tr); if (open) body.append(h("tr", { class: "detail" }, h("td", { colspan: colspan || cols.length }, h("div", { class: "detail-in" }, detail(r)))));
  });
  return h("table", {}, head, body);
}

/* ---------- données dérivées partagées ---------- */
const marketMap = () => Object.fromEntries((App.S?.hl.markets || []).map((m) => [m.coin, m]));
const fundingAnn = (m) => m.funding * 24 * 365;   // taux annualisé
function historyAt(msAgo) {
  const hs = App.S?.history || []; if (hs.length < 2) return null;
  const target = Date.now() - msAgo, first = hs[0].t; if (first > target + 120000) return null;
  let best = hs[0]; for (const p of hs) if (Math.abs(p.t - target) < Math.abs(best.t - target)) best = p; return best;
}
function buildSetups(S) {
  const mk = marketMap(), out = [];
  for (const s of S.sentiment) {
    const n = (s.hl ? s.hl.nLong + s.hl.nShort : 0) + (s.pm ? s.pm.nBull + s.pm.nBear : 0), m = s.coin && mk[s.coin];
    if (n < 6 || Math.abs(s.score) < 0.3) continue;
    const dir = s.score > 0 ? 1 : -1, facts = [], flags = []; let pips = 1;
    if (s.agree === "aligned") { pips++; facts.push("Hyperliquid et Polymarket pointent dans le même sens."); } else if (s.agree === "diverge") flags.push("Hyperliquid et Polymarket divergent.");
    if (s.elite && s.elite.nLong + s.elite.nShort >= 4) {
      if (Math.sign(s.elite.score) === dir && Math.abs(s.elite.score) >= 0.3) { pips++; facts.push(`Les 20 meilleurs comptes (ROI du mois) suivent : ${spct(s.elite.score)}.`); } else flags.push(`Les meilleurs comptes sont à ${spct(s.elite.score)} : pas de confirmation.`);
    }
    if (m) {
      const f = fundingAnn(m);
      if (dir * f <= 0.1) { pips++; facts.push(`Funding ${spct(f, 1)}/an : ${dir > 0 ? "les longs ne paient pas cher" : "les shorts sont payés ou presque"}.`); } else flags.push(`Funding ${spct(f, 1)}/an : ${dir > 0 ? "longs encombrés" : "shorts encombrés"}, risque de squeeze inverse.`);
      if (Math.sign(m.chg) === dir) facts.push(`Prix ${spct(m.chg, 1)} sur 24 h, dans le sens du biais.`); else flags.push(`Prix ${spct(m.chg, 1)} sur 24 h, à contre-courant.`);
    }
    out.push({ s, dir, pips: Math.min(4, pips), facts, flags, m });
  }
  return out.sort((a, b) => b.pips - a.pips || b.s.conviction - a.s.conviction).slice(0, 4);
}

/* ---------- événements : textes ---------- */
const KIND = { open: "a ouvert", add: "a renforcé", reduce: "a réduit", close: "a fermé" };
function evText(e) {
  const nm = Drawer.walletBtn({ addr: e.addr, name: e.name }, e.src);
  if (e.src === "hl") return h("span", {}, h("b", {}, nm), ` ${KIND[e.kind]} un `, h("span", { class: "chip " + (e.side === "long" ? "up" : "down") }, e.side === "long" ? "LONG" : "SHORT"), " ", h("b", {}, Drawer.assetBtn(e.coin)), " ", h("span", { class: "mono" }, usd(Math.abs(e.delta)), e.kind === "open" || e.kind === "close" ? "" : ` (total ${usd(e.notional)})`));
  return h("span", {}, h("b", {}, nm), ` ${KIND[e.kind]} `, h("span", { class: "chip neutral" }, e.outcome), " sur « ", Drawer.marketBtn(e), " » ", h("span", { class: "mono" }, usd(Math.abs(e.delta)), ` à ${(e.price * 100).toFixed(0)}¢`));
}
function evIcon(e) {
  const dirUp = e.src === "hl" ? (e.side === "long") : (e.view ? e.view > 0 : null);
  const grow = e.kind === "open" || e.kind === "add", sym = e.kind === "open" ? "＋" : e.kind === "add" ? "↑" : e.kind === "reduce" ? "↓" : "✕";
  const tone = !grow ? "neutral" : dirUp == null ? "neutral" : dirUp ? "up" : "down";
  return h("div", { class: "ic " + tone, title: e.kind }, sym);
}
function evRow(e, fresh, compact) {
  const tags = [h("span", { class: "chip neutral" }, e.src === "hl" ? "HL" : "PM"), e.since ? h("span", { class: "chip cyan", title: "Détecté à l'ouverture de la page, en comparant avec la dernière collecte" }, "depuis la dernière collecte") : null];
  return h("div", { class: "ev" + (fresh ? " fresh" : "") + (compact ? " compact" : "") }, evIcon(e), h("div", { class: "tx" }, evText(e), " ", ...tags), h("div", { class: "tm", title: new Date(e.t).toLocaleString("fr-FR") }, ago(e.t)));
}

/* ---------- actualités : ligne commune ---------- */
const ASSET_LBL = { US_EQ: "Actions US", NDX: "Nasdaq", OIL: "Pétrole", GOLD: "Or", NATGAS: "Gaz", USD: "Dollar", BTC: "BTC", ETH: "ETH", NVDA: "Nvidia", SILVER: "Argent" };
function newsRow(n, { net } = {}) {
  return h("div", { class: "nrow" + (n.hot ? " hot" : "") }, h("div", { class: "tm" }, ago(n.t)), h("div", { class: "tx" }, n.url ? mkLink(n.url, n.title) : n.title,
    h("div", { class: "meta" }, net && n.net ? h("span", { class: "chip cyan" }, n.net) : null, h("span", { class: "dim" }, n.src || ""), n.hot ? h("span", { class: "chip down" }, "urgent") : null, (n.assets || []).map((a) => h("span", { class: "chip neutral" }, ASSET_LBL[a] || a)))));
}
const X = () => App.S?.x || {};

/* ---------- routeur ---------- */
const ICONS = {
  dash: "M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z", hl: "M3 17l5-6 4 4 8-10", pm: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2", sent: "M12 3a9 9 0 100 18 9 9 0 000-18zM15.5 8.5l-2 5-5 2 2-5z",
  flux: "M3 12h4l3-8 4 16 3-8h4", liq: "M12 3c3 4 6 6 6 10a6 6 0 01-12 0c0-4 3-6 6-10z", funding: "M5 20V11M11 20V4M17 20v-6M2 20h20", histo: "M3 3v18h18M7 15l4-4 3 3 5-6", calc: "M6 3h12v18H6zM9 7h6M9 12h1M12.5 12h1M9 16h1M12.5 16h1",
  dirs: "M12 3v18M12 3l-5 5M12 3l5 5M5 21h14", edge: "M13 2L4 14h7l-1 8 9-12h-7z", globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18", news: "M4 5h13v14H6a2 2 0 01-2-2zM17 9h3v8a2 2 0 01-2 2M7 9h7M7 13h7M7 16h4",
  social: "M4 5h16v11H9l-5 4z", cal: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4", odds: "M4 20V4M4 20h16M8 16l3-5 3 3 5-8", macro: "M3 20h18M6 20V10M10 20V6M14 20v-7M18 20V4", xasset: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  cot: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z", tape: "M4 5h16M4 10h10M4 15h16M4 20h7M18 9l3 3-3 3", opts: "M3 18c4 0 5-12 9-12s5 12 9 12", paper: "M3 17l5-5 4 3 7-8M15 7h4v4M3 21h18", xalpha: "M4 4l16 16M20 4L4 20",
};
const ROUTES = [
  { id: "dash", t: "Tableau de bord", g: "Synthèse" }, { id: "dirs", t: "Directions", g: "Synthèse" }, { id: "edge", t: "Signaux d'edge", g: "Synthèse" }, { id: "paper", t: "Paper trading", g: "Synthèse" }, { id: "xalpha", t: "X Alpha (ε / ∞)", g: "Synthèse" },
  { id: "globe", t: "Globe", g: "Monde" }, { id: "news", t: "Infos et réseaux", g: "Monde" }, { id: "cal", t: "Calendrier", g: "Monde" }, { id: "odds", t: "Probabilités", g: "Monde" },
  { id: "macro", t: "Macro", g: "Marchés" }, { id: "xasset", t: "Prix et funding", g: "Marchés" }, { id: "cot", t: "Hedge funds", g: "Marchés" }, { id: "opts", t: "Options", g: "Marchés" }, { id: "liq", t: "Liquidations", g: "Marchés" },
  { id: "sent", t: "Sentiment", g: "Baleines" }, { id: "hl", t: "Hyperliquid", g: "Baleines" }, { id: "pm", t: "Polymarket", g: "Baleines" }, { id: "flux", t: "Flux en direct", g: "Baleines" }, { id: "tape", t: "Whale Tape", g: "Baleines" },
  { id: "calc", t: "Calculateur", g: "Outil" },
];
const ALIAS = { funding: "xasset", histo: "sent", social: "news" };   // anciennes pages, désormais intégrées
// intègre une vue dans une autre, sous un intertitre
function fold(parent, child, title, sub) {
  const P = App.views[parent], C = App.views[child], init = P.init.bind(P), upd = P.update.bind(P);
  P.init = (box) => { init(box); const sec = h("div", { class: "view sub" }, h("div", { class: "sechead" }, h("h2", {}, title), sub ? h("p", {}, sub) : null)); box.append(sec); C.init(sec); };
  P.update = (S) => { upd(S); C.update(S); };
  delete App.views[child];
}

function buildChrome() {
  const rail = $("rail"); document.body.prepend(h("a", { class: "skip", href: "#stage" }, "Aller au contenu"));
  const logo = h("div", { class: "logo" }, h("svg", { width: 30, height: 30, viewBox: "0 0 32 32", "aria-hidden": "true" },
    h("circle", { cx: 16, cy: 16, r: 13, fill: "none", stroke: "#4cc9f0", "stroke-width": 1.6 }), h("path", { d: "M16 5l3.2 9.2L16 16l-3.2-1.8z", fill: "#f2616d" }), h("path", { d: "M16 27l-3.2-9.2L16 16l3.2 1.8z", fill: "#3ecf8e" }), h("circle", { cx: 16, cy: 16, r: 1.8, fill: "#0a0d12" })),
    h("div", {}, h("b", {}, "Boussole"), h("small", {}, "des baleines")));
  const spin = h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", class: "spin" }, h("path", { d: "M20 12a8 8 0 11-2.6-5.9M20 4v5h-5" }));
  rail.append(logo, h("div", { class: "refresh-box" }, h("button", { class: "refresh", id: "refreshBtn", type: "button", onclick: () => App.requestRefresh && App.requestRefresh() }, spin, h("span", { id: "refreshLbl" }, "Actualiser")), h("div", { class: "refresh-age", id: "refreshAge" })));
  document.body.append(h("div", { class: "toast", id: "toast", role: "status", "aria-live": "polite" }), h("div", { class: "modal", id: "modal", hidden: "", role: "dialog", "aria-modal": "true", "aria-labelledby": "modalT" }));
  for (const g of [...new Set(ROUTES.map((r) => r.g))]) {
    const grp = h("div", { class: "grp" }, h("div", { class: "cap" }, g));
    for (const r of ROUTES.filter((x) => x.g === g)) grp.append(h("button", { class: "nav", type: "button", id: "nav-" + r.id, onclick: () => (location.hash = r.id) },
      h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, h("path", { d: ICONS[r.id] })), r.t, r.id === "flux" ? h("span", { class: "badge", id: "fluxBadge", hidden: "" }) : null));
    rail.append(grp);
  }
  // pied du rail : état de la connexion ; l'âge de chaque source est dans un tiroir (l'âge global est sous « Actualiser »)
  rail.append(h("div", { class: "foot" }, h("div", { class: "live" }, h("span", { class: "dot", id: "dot" }), h("span", { id: "liveTxt" }, "connexion…")),
    h("details", {}, h("summary", {}, "Fraîcheur des sources"), h("div", { id: "ages", style: "margin-top:6px;line-height:1.6" }))));
  const stage = $("stage");
  for (const r of ROUTES) stage.append(h("section", { class: "view", id: "v-" + r.id, hidden: "", "aria-labelledby": "h-" + r.id }));
}
App.refresh = () => { if (!App.S) return; const v = App.views[App.cur]; if (v) { App.keep(() => v.update(App.S)); } };
App.keep = (fn) => { const y = window.scrollY; fn(); window.scrollTo(0, y); };
function route() {
  const want = ALIAS[location.hash.slice(1)] || location.hash.slice(1), id = ROUTES.some((r) => r.id === want) ? want : "dash";
  const prev = App.cur; if (prev && prev !== id && App.views[prev]?.leave) App.views[prev].leave();
  App.cur = id;
  for (const r of ROUTES) { $("v-" + r.id).hidden = r.id !== id; const n = $("nav-" + r.id); id === r.id ? n.setAttribute("aria-current", "page") : n.removeAttribute("aria-current"); }
  const v = App.views[id], box = $("v-" + id);
  if (v && !App.inited[id]) {
    const r = ROUTES.find((x) => x.id === id); box.append(h("div", { class: "pagehead" }, h("h1", { id: "h-" + id, tabindex: "-1" }, ...v.title(), ), v.sub ? h("p", {}, v.sub) : null));
    v.init(box); App.inited[id] = true;
  }
  if (id === "flux") { App.seenEv = App.S?.events.length ? App.S.events[0].t : Date.now(); badge(0); }
  if (App.S && v) v.update(App.S); window.scrollTo(0, 0); if (App.routed) $("h-" + id)?.focus({ preventScroll: true }); App.routed = true; document.title = "Boussole des baleines · " + ROUTES.find((x) => x.id === id).t;
}
function badge(n) { const b = $("fluxBadge"); if (!b) return; b.hidden = !n; b.textContent = n > 99 ? "99+" : n; }

/* ---------- mise en ordre automatique de la vue affichée (toutes les pages) ----------
   Après chaque rendu : colonnes numériques alignées à droite (chiffres tabulaires), cellules longues coupées sur une ligne
   avec le texte complet en infobulle, tableaux et listes au-delà de 15 entrées repliés derrière « Voir plus », sous-titre de
   page sur une ligne (clic pour le déplier). L'état « Voir plus » survit aux rafraîchissements en direct. */
const Tidy = (() => {
  const NUM = /^[−+\-]?\s?[$€]?\s?[−+\-]?\d[\d\s\u202f\u00a0.,]*\s?(%|×|x|k|M|Md|\$|R|¢|pts?|h|j|min|s|bp|pb)?(\s?·.*)?$|^—$|^–$/;
  const LIMIT = 15, expanded = new Set();
  const isNum = (td) => { const t = td.textContent.trim(); return t !== "" && NUM.test(t) && !td.querySelector("button, a[href^='http']"); };
  function table(t, key) {
    if (t.dataset.tidy) return;
    t.dataset.tidy = "1";
    const head = [...(t.tHead?.rows[0]?.cells || [])], rows = [...(t.tBodies[0]?.rows || [])].filter((r) => !r.classList.contains("detail"));
    const ncol = Math.max(head.length, ...rows.slice(0, 30).map((r) => r.cells.length));
    for (let c = 0; c < ncol; c++) {
      const cells = rows.map((r) => r.cells[c]).filter((x) => x && x.colSpan === 1 && x.textContent.trim() !== "" && x.textContent.trim() !== "—");
      if (cells.length && cells.filter(isNum).length / cells.length >= 0.7) { head[c]?.classList.add("num"); rows.forEach((r) => r.cells[c]?.colSpan === 1 && r.cells[c].classList.add("num")); }
    }
    for (const r of rows) for (const td of r.cells) { const s = td.textContent.trim(); if (s.length > 34 && !td.title) td.title = s; }
    if (rows.length > LIMIT + 5 && !expanded.has(key)) {
      rows.slice(LIMIT).forEach((r) => { r.classList.add("tidy-hidden"); const n = r.nextElementSibling; if (n?.classList.contains("detail")) n.classList.add("tidy-hidden"); });
      const host = t.closest(".scroll") || t;
      host.after(h("button", { type: "button", class: "more-btn", onclick: (e) => { expanded.add(key); t.querySelectorAll(".tidy-hidden").forEach((x) => x.classList.remove("tidy-hidden")); e.currentTarget.remove(); } }, `Voir plus (${rows.length - LIMIT})`));
    }
  }
  function list(box, key) {
    if (box.dataset.tidy) return;
    box.dataset.tidy = "1";
    const items = [...box.children].filter((x) => x.matches(".ev, .nrow, .orow, .card, li"));
    if (items.length <= LIMIT + 5 || expanded.has(key)) return;
    items.slice(LIMIT).forEach((x) => x.classList.add("tidy-hidden"));
    box.after(h("button", { type: "button", class: "more-btn", onclick: (e) => { expanded.add(key); items.forEach((x) => x.classList.remove("tidy-hidden")); e.currentTarget.remove(); } }, `Voir plus (${items.length - LIMIT})`));
  }
  function run(view) {
    if (!view || view.hidden) return;
    const id = view.id;
    view.querySelectorAll("table").forEach((t, i) => table(t, `${id}:t${i}:${t.tHead?.textContent.slice(0, 40) || ""}`));
    view.querySelectorAll(".feed, .nlist, .evlist, ul.log").forEach((b, i) => list(b, `${id}:l${i}`));
    const p = view.querySelector(".pagehead p");
    if (p && !p.dataset.tidy) { p.dataset.tidy = "1"; p.title = "Cliquer pour lire la présentation complète"; p.onclick = () => p.classList.toggle("open"); }
  }
  let pending = false;
  const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; run(document.querySelector(".view:not([hidden])")); }); };
  return { run, start() { new MutationObserver(schedule).observe($("stage"), { childList: true, subtree: true }); schedule(); } };
})();
