"use strict";
/* Institutionnel et synthèse : macro, marchés, hedge funds (CFTC), options, directions, signaux d'edge. */
const fmtUnit = (s, v) => s.unit === "%" ? v.toFixed(2) + " %" : s.unit === "pt" ? v.toFixed(2) + " pt" : s.unit === "k Md$" ? v.toFixed(2) + " k Md$" : s.unit === "M$" ? usd(v * 1e6) : s.unit === "Md$" ? usd(v * 1e9) : s.unit === "n" ? Math.round(v).toLocaleString("fr-FR") : s.unit === "$" ? "$" + v.toFixed(1) : v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const fmtChg = (s, v) => (v > 0 ? "+" : v < 0 ? "−" : "") + (s.unit === "%" || s.unit === "pt" ? Math.abs(v).toFixed(2) + " pt" : s.unit === "k Md$" ? Math.round(Math.abs(v) * 1000) + " Md$" : s.unit === "M$" ? usd(Math.abs(v) * 1e6).replace("$", "") + " $" : s.unit === "Md$" ? Math.round(Math.abs(v)) + " Md$" : Math.abs(v).toLocaleString("fr-FR", { maximumFractionDigits: 2 }));

/* ---------- MACRO ---------- */
App.views.macro = (() => {
  const z = {};
  return {
    title: () => ["Macro & ", h("em", {}, "liquidité")],
    sub: "Le décor dans lequel tous les actifs évoluent : taux, inflation, crédit, dollar et liquidité. Le score de régime résume si l'environnement pousse à prendre du risque ou à s'en protéger.",
    init(box) { z.g = h("div", { class: "gauge-box" }); z.parts = h("div", {}); z.curve = h("div", {}); z.groups = h("div", { class: "scroll" });
      box.append(h("div", { class: "grid g2" }, panel("Régime de marché", { sub: "aversion ← → appétit pour le risque" }, h("div", { class: "hero", style: "grid-template-columns:minmax(200px,280px) minmax(0,1fr)" }, z.g, z.parts)), panel("Courbe des taux américains", { sub: "aujourd'hui, il y a 1 mois, il y a 1 an" }, z.curve, h("div", { class: "legend", style: "margin-top:8px" }, h("span", {}, h("i", { style: "background:var(--cyan)" }), "Aujourd'hui"), h("span", {}, h("i", { style: "background:var(--violet)" }), "Il y a 1 mois"), h("span", {}, h("i", { style: "background:var(--dim)" }), "Il y a 1 an")))),
        panel("Indicateurs", { sub: "dernière valeur et variation, par famille", noteText: "Source : Réserve fédérale de Saint-Louis (FRED), mise à jour toutes les 6 heures. Liquidité nette = bilan de la Fed − compte du Trésor − reverse repo, suivie par les desks macro pour anticiper les actifs risqués." }, z.groups)); },
    update(S) {
      const m = X().macro; if (!m) return z.groups.replaceChildren(empty("Chargement des séries macro…"));
      z.g.replaceChildren(Ch.gauge(m.regime.score, { w: 260 }), h("div", { class: "val " + toneOf(m.regime.score), style: "font-size:1.1rem" }, m.regime.label));
      z.parts.replaceChildren(...m.regime.parts.map((p) => dbar(p.name, p.text, p.score, spct(p.score), null)));
      Ch.curve(z.curve, m.curve.tenors, [{ name: "Il y a 1 an", color: Ch.C.dim, vals: m.curve.y1, dash: "4 4" }, { name: "Il y a 1 mois", color: Ch.C.violet, vals: m.curve.m1, dash: "6 3" }, { name: "Aujourd'hui", color: Ch.C.cyan, vals: m.curve.now, w: 2.6 }]);
      const groups = {}; for (const s of Object.values(m.series)) (groups[s.group] ??= []).push(s);
      const fams = ["Liquidité", "Taux", "Courbe", "Inflation", "Emploi", "Crédit", "Risque", "Devises", "Matières", "Actions"].filter((g) => groups[g]);
      z.groups.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ["Indicateur", "Dernier", "1 mois", "1 an", "Tendance"].map((t, i) => h("th", { scope: "col", class: i && i < 4 ? "num" : "" }, t)))),
        h("tbody", {}, fams.flatMap((g) => [h("tr", { class: "grouprow" }, h("td", { colspan: 5 }, g)), ...groups[g].map((s) => h("tr", {}, h("td", { title: s.label }, s.label), h("td", { class: "num" }, fmtUnit(s, s.last)),
          h("td", { class: "num " + cls(s.m1) }, fmtChg(s, s.m1)), h("td", { class: "num " + cls(s.y1) }, fmtChg(s, s.y1)), h("td", {}, Ch.spark(s.spark, { w: 96, h: 22, color: s.m1 >= 0 ? Ch.C.cyan : Ch.C.violet }))))]))));
    },
  };
})();

/* ---------- MARCHÉS (multi-actifs) ---------- */
App.views.xasset = (() => {
  const z = {};
  const IDX = new Set(["SP500", "XYZ100", "JP225", "KR200", "VIX", "EWY", "EWJ", "XLE", "URNM"]), COM = new Set(["GOLD", "SILVER", "CL", "BRENTOIL", "COPPER", "NATGAS", "URANIUM", "ALUMINIUM", "PLATINUM", "PALLADIUM", "CORN", "WHEAT", "TTF"]), FX = new Set(["EUR", "JPY", "DXY", "GBP", "CHF"]);
  const group = (c) => !c.startsWith("xyz:") ? "Crypto" : IDX.has(c.slice(4)) ? "Indices" : COM.has(c.slice(4)) ? "Matières premières" : FX.has(c.slice(4)) ? "Devises" : "Actions";
  const heatCol = (v, k = 0.04) => { const a = Math.min(1, Math.abs(v) / k); return v >= 0 ? `rgba(43,255,176,${0.08 + a * 0.5})` : `rgba(255,61,134,${0.08 + a * 0.5})`; };
  return {
    title: () => ["Marchés ", h("em", {}, "multi-actifs")],
    sub: "Crypto, indices, actions, matières premières et devises sur un seul écran, cotés en continu sur Hyperliquid. Avec le momentum, la volatilité et les corrélations pour voir ce qui bouge ensemble.",
    init(box) { z.tiles = h("div", { style: "display:flex;flex-direction:column;gap:18px" }); z.mom = h("div", { class: "scroll" }); z.corr = h("div", { class: "scroll" });
      box.append(panel("Carte de chaleur sur 24 h", { sub: "vert = hausse, rose = baisse" }, z.tiles), panel("Momentum et risque", { sub: "bougies quotidiennes" }, z.mom), panel("Corrélations sur 30 jours", { sub: "+1 = bougent ensemble, −1 = en sens inverse", noteText: "Une corrélation élevée entre crypto et actions signifie qu'un même facteur (liquidité, risque) pilote les deux : diversifier entre elles protège peu." }, z.corr)); },
    update(S) {
      const mk = S.hl.markets.filter((m) => m.coin.startsWith("xyz:") || m.oi >= 3e7), gs = {}; for (const m of mk) (gs[group(m.coin)] ??= []).push(m);
      z.tiles.replaceChildren(...["Crypto", "Indices", "Actions", "Matières premières", "Devises"].filter((g) => gs[g]).map((g) => h("div", {}, h("h3", { style: "margin-bottom:8px" }, g), h("div", { class: "tiles" }, gs[g].sort((a, b) => b.oi - a.oi).slice(0, 28).map((m) => h("button", { class: "tile", type: "button", style: `background:${heatCol(m.chg)}`, title: `${coinName(m.coin)} · OI ${usd(m.oi)} · funding ${spct(fundingAnn(m), 1)}/an`, onclick: () => { ui.calc.coin = m.coin; save(); location.hash = "calc"; } }, h("b", {}, coinName(m.coin)), h("span", { class: "mono " + cls(m.chg) }, spct(m.chg, 1)), h("span", { class: "mono dim" }, px(m.mark))))))));
      const c = X().candles; if (!c) { z.mom.replaceChildren(empty("Chargement des bougies…")); return; }
      const pcell = (v) => v == null ? h("span", { class: "dim" }, "–") : h("span", { class: "mono " + cls(v) }, spct(v, 1));
      z.mom.replaceChildren(sortableTable("mom", [{ t: "Actif", cell: (s) => h("b", {}, coinName(s.coin)) }, { t: "Prix", cls: "r", cell: (s) => h("span", { class: "mono" }, px(s.last)) }, { t: "7 j", cls: "r", sort: (s) => s.r7 ?? 0, cell: (s) => pcell(s.r7) }, { t: "30 j", cls: "r", sort: (s) => s.r30 ?? 0, cell: (s) => pcell(s.r30) }, { t: "Volatilité 30 j", cls: "r", sort: (s) => s.vol30, cell: (s) => h("span", { class: "mono" }, pct(s.vol30)) }, { t: "60 jours", cell: (s) => Ch.spark(s.spark, { w: 110, h: 28, color: s.r30 >= 0 ? Ch.C.up : Ch.C.down }) }], Object.values(c.stats), { defaultSort: { k: "30 j", dir: "desc" } }));
      const n = c.coins.length;
      z.corr.replaceChildren(h("div", { class: "matrix", style: `grid-template-columns:70px repeat(${n},minmax(38px,1fr))` }, h("div", {}), c.coins.map((k) => h("div", { class: "mh" }, coinName(k))), c.coins.flatMap((a, i) => [h("div", { class: "mh", style: "text-align:left" }, coinName(a)), ...c.corr[i].map((v, j) => h("div", { class: "mc", style: `background:${v == null ? "transparent" : i === j ? "rgba(255,255,255,.06)" : heatCol(v, 1)}`, title: `${coinName(a)} / ${coinName(c.coins[j])} : ${v ?? "–"}` }, v == null ? "" : i === j ? "" : v.toFixed(2)))])));
    },
  };
})();

/* ---------- HEDGE FUNDS (CFTC) ---------- */
App.views.cot = (() => {
  const z = {};
  const pbar = (p) => h("div", { style: "display:flex;align-items:center;gap:8px" }, h("div", { style: "position:relative;width:110px;height:8px;border-radius:4px;background:linear-gradient(90deg,rgba(255,61,134,.45),rgba(255,255,255,.06) 25%,rgba(255,255,255,.06) 75%,rgba(43,255,176,.45))" }, h("i", { style: `position:absolute;top:-3px;width:4px;height:14px;border-radius:2px;left:calc(${p * 100}% - 2px);background:#fff;box-shadow:0 0 8px #fff` })), h("span", { class: "mono " + (p >= 0.9 || p <= 0.1 ? "warn" : "muted") }, Math.round(p * 100) + "e"));
  return {
    title: () => ["Positions des ", h("em", {}, "hedge funds")],
    sub: "Ce que détiennent réellement les fonds spéculatifs sur les marchés à terme américains, publié chaque vendredi par le régulateur (CFTC). Un positionnement extrême est un signal classique de retournement.",
    init(box) { z.tbl = h("div", { class: "scroll" }); box.append(panel("Position nette des fonds à effet de levier", { sub: "en % de l'open interest", noteText: "Centile : position actuelle par rapport aux 3 dernières années (0 = plus vendeur que jamais, 100 = plus acheteur que jamais). Matières premières : catégorie « managed money ». Bitcoin et bons du Trésor : les fonds y sont structurellement vendeurs (arbitrage comptant contre futur), ce qui n'est pas un pari baissier." }, z.tbl)); },
    update(S) {
      const c = X().cot; if (!c?.markets?.length) return z.tbl.replaceChildren(empty("Chargement du rapport CFTC…"));
      z.tbl.replaceChildren(sortableTable("cot", [{ t: "Marché", cell: (m) => h("b", {}, m.name) }, { t: "Net hedge funds", sort: (m) => m.net, cell: (m) => h("div", { style: "display:flex;align-items:center;gap:8px" }, h("div", { style: "position:relative;width:100px;height:8px;background:rgba(255,255,255,.06);border-radius:4px" }, h("i", { style: `position:absolute;top:0;bottom:0;border-radius:4px;left:${m.net >= 0 ? 50 : 50 - Math.min(50, Math.abs(m.net) * 125)}%;width:${Math.min(50, Math.abs(m.net) * 125)}%;background:${m.net >= 0 ? "var(--mint)" : "var(--rose)"}` })), h("span", { class: "mono " + cls(m.net) }, spct(m.net, 1))) },
        { t: "4 sem.", cls: "r", sort: (m) => m.w4, cell: (m) => h("span", { class: "mono " + cls(m.w4) }, spct(m.w4, 1)) }, { t: "Centile 3 ans", sort: (m) => m.pctl, cell: (m) => pbar(m.pctl) },
        { t: "Gérants d'actifs", cls: "r", sort: (m) => m.am?.net ?? -9, cell: (m) => m.am ? h("span", { class: "mono " + cls(m.am.net) }, spct(m.am.net, 1)) : h("span", { class: "dim" }, "–") }, { t: "Lecture", cell: (m) => m.pctl >= 0.9 ? h("span", { class: "chip warn" }, "extrême acheteur") : m.pctl <= 0.1 ? h("span", { class: "chip warn" }, "extrême vendeur") : null }], c.markets, {}));
      z.tbl.append(h("p", { class: "muted", style: "margin:10px 0 0;font-size:.8rem" }, "Rapport du " + new Date(c.markets[0].date).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) + " (positions arrêtées le mardi, publiées le vendredi)."));
    },
  };
})();

/* ---------- OPTIONS ---------- */
App.views.opts = (() => {
  const z = {}; let cur = "BTC";
  return {
    title: () => ["Marché des ", h("em", {}, "options")],
    sub: "Ce que paient les professionnels pour se couvrir ou parier sur Bitcoin et Ethereum (Deribit). Volatilité attendue, demande de protection, et le prix où les vendeurs d'options gagnent le plus à l'échéance.",
    init(box) { z.seg = h("div", { class: "seg" }); z.kpis = h("div", { class: "kpis" }); z.chart = h("div", {}); z.term = h("div", { class: "scroll" }); z.ttl = h("span", { class: "muted" });
      box.append(h("div", { class: "toolbar" }, z.seg), z.kpis, panel("Open interest par prix d'exercice", { tools: z.ttl }, z.chart, h("div", { class: "legend", style: "margin-top:8px" }, h("span", {}, h("i", { style: "background:var(--mint)" }), "Calls (paris haussiers)"), h("span", {}, h("i", { style: "background:var(--rose)" }), "Puts (protections)"))), panel("Structure par échéance", { noteText: "Écart put − call : différence de volatilité implicite entre un put 10 % sous le prix et un call 10 % au-dessus. Positif = la protection à la baisse coûte plus cher. Max pain : prix auquel le plus d'options expirent sans valeur." }, z.term)); },
    update(S) {
      const list = X().options?.list || []; if (!list.length) return z.chart.replaceChildren(empty("Chargement des options…"));
      seg(z.seg, list.map((o) => [o.cur, o.cur]), cur, (k) => (cur = k)); const o = list.find((x) => x.cur === cur) || list[0];
      z.kpis.replaceChildren(kpi("Volatilité implicite (DVOL)", o.dvol ? o.dvol.toFixed(1) : "–", o.dvolChg7 != null ? `${o.dvolChg7 > 0 ? "+" : ""}${o.dvolChg7.toFixed(1)} pts sur 7 jours` : "", o.dvolChg7 > 5 ? "warn" : ""), kpi("Ratio puts / calls", o.pcr.toFixed(2), o.pcr > 1 ? "plus de protections que de paris haussiers" : "plus de calls que de puts", o.pcr > 1 ? "down" : "up"),
        kpi("Écart put − call à 30 j", o.skew30 != null ? (o.skew30 > 0 ? "+" : "") + o.skew30.toFixed(1) + " pts" : "–", o.skew30 > 5 ? "forte demande de protection" : o.skew30 < -2 ? "demande de calls" : "équilibré", o.skew30 > 5 ? "down" : ""), kpi("Max pain", px(o.main.maxPain), `${spct(o.main.maxPain / o.spot - 1, 1)} du prix (${px(o.spot)}) · OI ${usd(o.oiUsd)}`));
      z.ttl.textContent = "échéance " + o.main.exp;
      Ch.strikes(z.chart, o.main.strikes, { fmtK: (k) => (k >= 1000 ? (k / 1000).toFixed(k % 1000 ? 1 : 0) + "k" : String(k)), fmtV: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)), marks: [{ k: o.spot, color: Ch.C.amber, label: "prix" }, { k: o.main.maxPain, color: Ch.C.cyan, label: "max pain" }] });
      z.term.replaceChildren(sortableTable("opt", [{ t: "Échéance", cell: (e) => h("span", {}, h("b", {}, e.exp), h("span", { class: "sub2" }, `dans ${e.days.toFixed(0)} j`)) }, { t: "Vol. implicite", cls: "r", cell: (e) => h("span", { class: "mono" }, e.atmIv ? e.atmIv.toFixed(1) + " %" : "–") }, { t: "Écart put − call", cls: "r", cell: (e) => e.skew == null ? "–" : h("span", { class: "mono " + (e.skew > 5 ? "down" : e.skew < -2 ? "up" : "") }, (e.skew > 0 ? "+" : "") + e.skew.toFixed(1)) },
        { t: "Puts / calls", cls: "r", cell: (e) => h("span", { class: "mono" }, e.pcr.toFixed(2)) }, { t: "Max pain", cls: "r", cell: (e) => h("span", { class: "mono" }, px(e.maxPain)) }, { t: "Open interest", cls: "r", cell: (e) => h("span", { class: "mono" }, usd(e.oi * o.spot)) }], o.exps, {}));
    },
  };
})();

/* ---------- DIRECTIONS ---------- */
function dirCard(d, compact) {
  const c = d.score >= 0.2 ? "var(--mint)" : d.score <= -0.2 ? "var(--rose)" : "var(--amber)", w = Math.min(1, Math.abs(d.score)) * 50;
  const head = h("div", { class: "top" }, h("b", {}, d.name), h("span", { class: "chip " + (d.n < 3 ? "neutral" : d.score >= 0.2 ? "up" : d.score <= -0.2 ? "down" : "warn") }, d.label), d.price ? h("span", { class: "mono muted" }, px(d.price)) : null, h("span", { class: "pips", title: `${d.agree} signaux sur ${d.n} vont dans ce sens`, style: `--c:${c}` }, Array.from({ length: d.n }, (_, i) => h("i", { class: i < d.agree ? "on" : "" }))));
  const bar = h("div", { class: "t", style: "position:relative;height:10px;background:rgba(255,255,255,.05);border-radius:5px;margin:4px 0" }, h("i", { style: `position:absolute;top:0;bottom:0;border-radius:5px;left:${d.score >= 0 ? 50 : 50 - w}%;width:${w}%;background:${c};box-shadow:0 0 12px ${c}` }), h("i", { style: "position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--dim)" }));
  if (compact) return h("a", { class: "setup", href: "#dirs", style: `--c:${c};color:inherit` }, head, bar, h("div", { class: "muted", style: "font-size:.76rem" }, d.parts[0] ? `${d.parts[0].name} : ${d.parts[0].text}` : "données insuffisantes"));
  return h("div", { class: "setup", style: `--c:${c};cursor:default` }, head, bar, h("div", { class: "mono muted", style: "font-size:.74rem" }, `score ${spct(d.score)} · 7 j ${d.r7 != null ? spct(d.r7, 1) : "–"} · 30 j ${d.r30 != null ? spct(d.r30, 1) : "–"}`),
    h("div", { style: "display:grid;gap:6px;margin-top:6px" }, d.parts.map((p) => h("div", { style: "display:grid;grid-template-columns:150px 70px minmax(0,1fr);gap:10px;align-items:center;font-size:.8rem" }, h("span", { style: "font-weight:700" }, p.name), h("div", { style: "position:relative;height:6px;background:rgba(255,255,255,.06);border-radius:3px" }, h("i", { style: `position:absolute;top:0;bottom:0;border-radius:3px;left:${p.score >= 0 ? 50 : 50 - Math.abs(p.score) * 50}%;width:${Math.abs(p.score) * 50}%;background:${p.score >= 0 ? "var(--mint)" : "var(--rose)"}` })), h("span", { class: "muted" }, p.text)))),
    d.against.length ? h("div", { class: "warn", style: "font-size:.78rem;margin-top:4px" }, "Contredit par : " + d.against.join(", ") + ".") : null);
}
App.views.dirs = (() => {
  const z = {};
  return {
    title: () => ["Directions de ", h("em", {}, "marché")],
    sub: "Une conclusion par actif, construite en pesant tous les signaux disponibles : tendance, baleines, hedge funds, options, régime macro, funding. Chaque ligne montre ce qui pousse dans un sens et ce qui s'y oppose.",
    init(box) { z.list = h("div", { class: "grid g2", style: "align-items:start" }); box.append(z.list, h("p", { class: "disclaimer" }, "Méthode : chaque signal est ramené entre −100 % et +100 %, puis pondéré (tendance et baleines pèsent le plus, funding le moins). Les points lumineux comptent les signaux qui vont dans le sens de la conclusion. C'est une lecture systématique de données publiques, pas un conseil d'investissement : elle peut se tromper, surtout quand les signaux se contredisent.")); },
    update(S) { z.list.replaceChildren(...(S.dirs?.length ? [...S.dirs].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).map((d) => dirCard(d)) : [empty("Calcul en cours…")])); },
  };
})();

/* ---------- SIGNAUX D'EDGE ---------- */
function edgeCard(e) {
  const c = e.tone === "up" ? "var(--mint)" : e.tone === "down" ? "var(--rose)" : "var(--amber)";
  return h("div", { class: "setup", style: `--c:${c};cursor:default` }, h("div", { class: "top" }, h("span", { class: "chip", style: `color:${c};border-color:${c}` }, e.kind), h("b", { style: "font-size:.86rem" }, e.title)), h("div", { class: "muted", style: "font-size:.82rem" }, e.detail), e.assets?.length ? h("div", { class: "chips" }, e.assets.map((a) => h("span", { class: "chip neutral" }, ASSET_LBL[a] || a))) : null);
}
App.views.edge = (() => {
  const z = {}; let kind = "all";
  return {
    title: () => ["Signaux ", h("em", {}, "d'edge")],
    sub: "Les endroits où deux sources se contredisent ou où un indicateur sort de sa plage habituelle. Ce sont des pistes à creuser : des données publiques, mais que peu de gens croisent entre elles.",
    init(box) { z.seg = h("div", { class: "seg" }); z.list = h("div", { class: "grid g2" }); z.alt = h("div", { class: "kpis", style: "grid-template-columns:repeat(auto-fill,minmax(230px,1fr))" }); z.apps = h("div", {}); z.wiki = h("div", { class: "scroll" });
      box.append(h("div", { class: "toolbar" }, z.seg), z.list, panel("Thermomètres alternatifs", { sub: "sentiment, liquidité crypto" }, z.alt), h("div", { class: "grid g2" }, panel("Applications de finance les plus téléchargées", { sub: "App Store États-Unis" }, z.apps, h("p", { class: "disclaimer", style: "margin:10px 0 0" }, "Quand Coinbase ou Robinhood grimpent dans le classement, les particuliers reviennent en masse : historiquement un signe de fin de hausse. Leur disparition du classement accompagne les creux.")), panel("Attention du grand public", { sub: "pages vues Wikipedia, hier contre la moyenne du mois" }, z.wiki))); },
    update(S) {
      const kinds = ["all", ...new Set((S.edge || []).map((e) => e.kind))]; seg(z.seg, kinds.map((k) => [k, k === "all" ? "Tous" : k]), kind, (k) => (kind = k));
      const list = (S.edge || []).filter((e) => kind === "all" || e.kind === kind);
      z.list.replaceChildren(...(list.length ? list.map(edgeCard) : [empty("Aucune anomalie détectée pour l'instant.")]));
      const x = X(), f = x.fng, st = x.stable;
      z.alt.replaceChildren(...[f ? h("div", { class: "kpi" }, h("div", { class: "l" }, "Peur et avidité (crypto)"), h("div", { style: "display:flex;justify-content:space-between;align-items:flex-end" }, h("div", { class: "v " + (f.value <= 25 ? "down" : f.value >= 75 ? "up" : "") }, f.value + " / 100"), Ch.spark(f.spark, { w: 100, h: 32, color: Ch.C.amber, min: 0, max: 100 })), h("div", { class: "s" }, `${f.value <= 25 ? "peur extrême" : f.value <= 45 ? "peur" : f.value < 55 ? "neutre" : f.value < 75 ? "avidité" : "avidité extrême"} · ${f.w1 > 0 ? "+" : ""}${f.w1} en 7 jours`)) : null,
        st ? h("div", { class: "kpi" }, h("div", { class: "l" }, "Offre de stablecoins"), h("div", { style: "display:flex;justify-content:space-between;align-items:flex-end" }, h("div", { class: "v" }, usd(st.total)), Ch.spark(st.spark, { w: 100, h: 32, color: st.p30 >= 0 ? Ch.C.up : Ch.C.down })), h("div", { class: "s" }, "7 j : ", h("span", { class: "mono " + cls(st.p7) }, spct(st.p7, 2)), " · 30 j : ", h("span", { class: "mono " + cls(st.p30) }, spct(st.p30, 2)))) : null,
        ...(x.options?.list || []).map((o) => h("div", { class: "kpi" }, h("div", { class: "l" }, "Volatilité implicite " + o.cur), h("div", { style: "display:flex;justify-content:space-between;align-items:flex-end" }, h("div", { class: "v" }, o.dvol ? o.dvol.toFixed(1) : "–"), Ch.spark(o.dvolSpark, { w: 100, h: 32, color: Ch.C.violet })), h("div", { class: "s" }, o.dvolChg7 != null ? `${o.dvolChg7 > 0 ? "+" : ""}${o.dvolChg7.toFixed(1)} pts sur 7 jours` : "")))].filter(Boolean));
      const ap = x.apps, prev = (x.appsHist || []).find((a) => ap && ap.at - a.at >= 5 * 86400e3);
      z.apps.replaceChildren(ap ? h("div", { class: "feed" }, ap.ranks.filter((a) => a.rank).sort((a, b) => a.rank - b.rank).map((a) => { const p = prev?.ranks.find((r) => r.name === a.name)?.rank; return h("div", { class: "orow" }, h("span", {}, h("span", { class: "mono dim", style: "display:inline-block;width:34px" }, "#" + a.rank), a.name), p ? h("span", { class: "mono " + cls(p - a.rank) }, p === a.rank ? "=" : (p > a.rank ? "▲ " : "▼ ") + Math.abs(p - a.rank)) : h("span", { class: "dim", style: "font-size:.72rem" }, "évolution dès 5 j d'historique")); }),
        h("div", { class: "muted", style: "font-size:.76rem;margin-top:6px" }, "Hors du top " + ap.size + " : " + (ap.ranks.filter((a) => !a.rank).map((a) => a.name).join(", ") || "aucune"))) : empty("Chargement…"));
      z.wiki.replaceChildren(x.wiki ? sortableTable("wiki", [{ t: "Sujet", cell: (w) => w.label }, { t: "Vues hier", cls: "r", sort: (w) => w.last, cell: (w) => h("span", { class: "mono" }, w.last.toLocaleString("fr-FR")) }, { t: "vs moyenne", cls: "r", sort: (w) => w.ratio, cell: (w) => h("span", { class: "mono " + (w.z >= 2.5 ? "warn" : w.ratio >= 1 ? "" : "muted") }, w.ratio.toFixed(1) + "×") }, { t: "45 jours", cell: (w) => Ch.spark(w.spark, { w: 100, h: 24, color: w.z >= 2.5 ? Ch.C.amber : Ch.C.cyan }) }], x.wiki.items.slice(0, 12), { defaultSort: { k: "vs moyenne", dir: "desc" } }) : empty("Chargement…"));
    },
  };
})();
