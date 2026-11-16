"use strict";
/* PolymarketWhaleModal — « Deep Whale Inspector » : tout le détail d'un compte Polymarket, sans quitter le site.
   Les données sont lues en direct dans le navigateur (API publique data-api.polymarket.com, v2), avec repli sur la dernière collecte. */
const PMWhale = (() => {
  const API = "https://data-api.polymarket.com/v2", GAMMA = "https://gamma-api.polymarket.com";
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const cache = new Map();
  let root, body, lastFocus, cur = null, ui = { q: "", cat: "all", sort: { k: "value", dir: -1 }, dust: false };

  const CATS = [
    ["sport", "Sport", /(spread:|moneyline|o\/u |over\/under|\b(vs\.?|nba|nfl|mlb|nhl|ufc|fifa|world cup|premier league|champions league|la liga|serie a|bundesliga|ligue 1|tennis|open:|grand prix|f1|masters|super bowl|olympic|win on \d|spread|o\/u|atp|wta|fc\b|united|boxing|cricket|golf|esports|lol:|cs2|dota)\b)/i],
    ["crypto", "Crypto", /\b(bitcoin|btc|ethereum|eth|solana|xrp|dogecoin|crypto|token|memecoin|airdrop|fdv|hyperliquid|stablecoin|binance|coinbase)\b/i],
    ["macro", "Macro / Fed", /\b(fed|fomc|powell|rate cut|rate hike|interest rate|inflation|cpi|gdp|recession|unemployment|jobs report|treasury|yield|s&p|nasdaq|dow|stock|earnings|ipo|tariff|oil|crude|gold|silver|ecb|boj)\b/i],
    ["geo", "Géopolitique", /\b(iran|israel|gaza|hamas|ukraine|russia|putin|zelensky|china|taiwan|north korea|ceasefire|war|invade|strike|nuclear|nato|sanction|venezuela|syria|houthi|hezbollah|military)\b/i],
    ["pol", "Politique", /\b(president|election|trump|biden|vance|congress|senate|house|governor|prime minister|parliament|democrat|democratic|republican|vote|minister|mayor|primary|nominee|nomination|presidential|cabinet|supreme court|impeach|resign|poll)\b/i],
  ];
  const catOf = (t) => (CATS.find((c) => c[2].test(t)) || ["other", "Autre"]).slice(0, 2);
  const CAT_COL = { sport: "#22e6ff", crypto: "#ffc247", macro: "#2bffb0", geo: "#ff3d86", pol: "#9a6bff", other: "#7c87b8" };

  const withCat = (p) => { const [cat, catL] = catOf(p.title || ""); return { ...p, cat, catL, d1: p.d1 ?? null }; };
  // repli : dernière collecte du site (quand le navigateur ne peut pas appeler l'API)
  function fromState(addr) {
    const S = App.S, w = S?.pm.whales.find((x) => x.addr.toLowerCase() === addr.toLowerCase());
    return { at: S?.pm.posAt || Date.now(), live: false, addr: addr.toLowerCase(), positions: (w?.positions || []).map((p) => { const [cat, catL] = catOf(p.title); return { ...p, size: p.size ?? (p.price ? p.value / p.price : 0), upnl: p.upnl ?? p.pnl, rpnl: p.rpnl ?? 0, pct: p.cost ? p.pnl / p.cost : 0, cat, catL, d1: null }; }), resolved: [], value: w?.total ?? null,
      activity: (S?.events || []).filter((e) => e.src === "pm" && e.addr === addr).map((e) => ({ t: e.t, type: "TRADE", side: e.kind === "open" || e.kind === "add" ? "BUY" : "SELL", usdc: Math.abs(e.delta), price: e.price, title: e.title, outcome: e.outcome, slug: e.slug })), pseudo: null, truncated: w ? w.nPositions > w.positions.length : false };
  }

  function ensure() {
    if (root) return;
    body = h("div", { class: "pmw-body" });
    root = h("div", { class: "pmw", hidden: "", role: "dialog", "aria-modal": "true", "aria-labelledby": "pmwT" }, h("div", { class: "pmw-scrim", onclick: close }), h("div", { class: "pmw-panel" }, body));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root && !root.hidden && !document.querySelector(".drawer:not([hidden])")) { e.stopPropagation(); close(); } }, true);
    document.body.append(root);
  }
  function close() { if (!root || root.hidden) return; root.hidden = true; cur = null; Ch.hideTip(); lastFocus?.focus?.(); }
  const copyBtn = (text, label) => h("button", { class: "btn", type: "button", onclick: async (e) => { const b = e.currentTarget; try { await navigator.clipboard.writeText(text); b.textContent = "Copié ✓"; } catch { b.textContent = text; } setTimeout(() => (b.textContent = label), 1600); } }, label);

  // Affichage en trois temps : (1) immédiat, depuis la dernière collecte ou la mémoire locale ; (2) les 15 plus grosses positions
  // en direct, en une requête prioritaire ; (3) le reste (pages suivantes, valeur, mouvements, variation 24 h) en arrière-plan.
  function seed(addr) {
    const d = fromState(addr); d.src = "dernière collecte"; d.resolved = [];
    if (!d.positions.length) { const m = PMApi.remembered(addr); if (m?.rows?.length) { d.positions = m.rows.map(withCat); d.at = m.at; d.src = "mémoire locale"; } }
    d.positions = d.positions.map(withCat); return d;
  }
  async function open(addr, name) {
    ensure(); if (root.hidden) lastFocus = document.activeElement; root.hidden = false; cur = addr.toLowerCase(); ui = { q: "", cat: "all", sort: { k: "value", dir: -1 }, dust: false };
    const a = cur, w = App.S?.pm.whales.find((x) => x.addr.toLowerCase() === a), d = seed(addr); root._meta = { addr, name: name || w?.name || null, w }; root._data = d; d.loading = true; render(); $("pmwClose")?.focus();
    const mine = () => cur === a && root._data === d, merge = (rows) => { const seen = new Set(d.positions.map((p) => p.token || p.cid + "|" + p.outcome)); for (const r of rows) { const k = r.token || r.cid + "|" + r.outcome; if (!seen.has(k)) { seen.add(k); d.positions.push(withCat(r)); } } };
    const apply = (res) => { if (!mine()) return; d.positions = res.data.rows.map(withCat); d.live = true; d.src = res.from; d.at = res.at; d.partial = res.data.more; d.err = null; d.loading = false; render(); };
    try {
      const r = await PMApi.top(addr, 15, { onFresh: apply }); apply(r);
      if (r.data.more) PMApi.rest(addr, r.data.cursor).then((x) => { if (!mine()) return; merge(x.rows); d.partial = x.more; render(); }).catch(() => {});
      PMApi.value(addr).then((v) => { if (mine()) { d.value = v.data; render(); } }).catch(() => {});
      PMApi.activity(addr).then((v) => { if (mine()) { d.activity = v.data; d.pseudo = v.data[0]?.pseudo || d.pseudo; render(); } }).catch(() => {});
      PMApi.resolved(addr).then((v) => { if (mine()) { d.resolved = v.data.map(withCat); render(); } }).catch(() => {});
      const top = r.data.rows.filter((p) => p.value > 1 && p.cid).slice(0, 40).map((p) => p.cid); if (top.length) PMApi.dayChange(top).then((by) => { if (!mine()) return; for (const p of d.positions) if (p.cid in by) p.d1 = (p.oi === 1 ? -1 : 1) * by[p.cid]; render(); }).catch(() => {});
    } catch (e) { if (!mine()) return; d.loading = false; d.err = e?.status === 429 ? "Polymarket limite temporairement les requêtes" : "Polymarket ne répond pas depuis cette page"; render(); }
  }
  function render() {
    const { addr, name, w } = root._meta, d = root._data, S = App.S;
    const title = name && !/^0x/i.test(name) ? name : d?.pseudo || sh(addr);
    const head = h("div", { class: "pmw-head" }, h("div", {}, h("div", { class: "dim", style: "font:500 .66rem var(--font-mono);letter-spacing:.12em;text-transform:uppercase" }, "Inspecteur de baleine · Polymarket"), h("h2", { id: "pmwT" }, title), h("div", { class: "mono dim", style: "font-size:.74rem;overflow-wrap:anywhere" }, addr, d?.pseudo && d.pseudo !== title ? " · " + d.pseudo : "")),
      h("div", { class: "toolbar" }, copyBtn(addr, "Copier l'adresse"), mkLink("https://polymarket.com/profile/" + addr, "Polymarket ↗", "btn"), h("button", { class: "btn on", type: "button", id: "pmwClose", onclick: close }, "Fermer ✕")));
    const q = PMApi.status(), srcLine = h("div", { class: "chips" }, h("span", { class: "chip " + (d.live ? "up" : "warn") }, d.live ? (d.src === "direct" ? "en direct" : d.src) + " · il y a " + ago(d.at) : d.src + (d.at ? " · " + ago(d.at) : "")), d.loading ? h("span", { class: "chip cyan" }, "actualisation en cours…") : null, d.partial ? h("span", { class: "chip neutral" }, "plus grosses positions d'abord, la suite arrive") : null, q.queued || q.cooling ? h("span", { class: "chip neutral" }, q.cooling ? `pause de ${Math.ceil(q.cooling / 1000)} s (limite de débit)` : `${q.queued} requête(s) en attente`) : null);
    const all = d.positions, act = all.filter((p) => p.value >= 1), dust = all.length - act.length, V = act.reduce((s, p) => s + p.value, 0) || 0;
    const upnl = act.reduce((s, p) => s + p.upnl, 0), cost = act.reduce((s, p) => s + p.cost, 0), rpnl = [...all, ...d.resolved].reduce((s, p) => s + p.rpnl, 0);
    const hhi = V ? act.reduce((s, p) => s + (p.value / V) ** 2, 0) : 0;
    const board = (per) => S?.pm.boards?.OVERALL?.[per]?.find((x) => x.addr.toLowerCase() === cur)?.pnl ?? null, pAll = board("ALL");
    const K = (l, v, s, c) => h("div", { class: "kpi" }, h("div", { class: "l" }, l), h("div", { class: "v " + (c || ""), style: "font-size:1.15rem" }, v), s ? h("div", { class: "s" }, s) : null);
    const kpis = h("div", { class: "kpis", style: "grid-template-columns:repeat(auto-fit,minmax(165px,1fr))" },
      K("Valeur des positions", usd(d.value ?? V), d.live ? "en direct" : d.src), K("PnL latent", signed(upnl), cost ? spct(upnl / cost, 1) + " sur le capital engagé" : "", cls(upnl)),
      K("PnL réalisé", signed(rpnl), `sur ${all.length + d.resolved.length} positions chargées`, cls(rpnl)), pAll != null ? K("PnL total (classement)", signed(pAll), "toutes périodes", cls(pAll)) : w ? K("PnL du mois", signed(w.pnlMonth), "classement Polymarket", cls(w.pnlMonth)) : null,
      K("Positions gagnantes", act.length ? pct(act.filter((p) => p.upnl > 0).length / act.length) : "–", act.length ? `${act.filter((p) => p.upnl > 0).length} en gain sur ${act.length} ouvertes` : "aucune position active"), K("Positions ouvertes", String(act.length), dust ? `+ ${dust} sans valeur (paris perdus non soldés)` : "toutes actives"),
      K("Concentration (Herfindahl)", V ? (hhi * 100).toFixed(1) + " %" : "–", V ? (hhi > 0.25 ? "très concentré" : hhi > 0.1 ? "concentré" : "diversifié") + ` · équiv. ${(1 / hhi).toFixed(1)} positions` : ""));
    // ---- tableau des positions
    const cats = ["all", ...new Set(act.map((p) => p.cat))], catLbl = (c) => (c === "all" ? "Toutes" : (CATS.find((x) => x[0] === c) || [0, "Autre"])[1]);
    const rows = (ui.dust ? all : act).filter((p) => (ui.cat === "all" || p.cat === ui.cat) && (!ui.q || (p.title + " " + p.outcome).toLowerCase().includes(ui.q)));
    const key = { value: (p) => p.value, pnl: (p) => p.upnl, pct: (p) => p.pct, d1: (p) => p.d1 ?? -9, size: (p) => p.size, avg: (p) => p.avg, price: (p) => p.price }[ui.sort.k]; rows.sort((a, b) => (key(a) - key(b)) * ui.sort.dir);
    const th = (lab, k, c) => h("th", { class: (c || "") + (k ? " sortable" : ""), scope: "col", onclick: k ? () => { ui.sort = { k, dir: ui.sort.k === k ? -ui.sort.dir : -1 }; render(); } : null }, lab + (ui.sort.k === k ? (ui.sort.dir < 0 ? " ▼" : " ▲") : ""));
    const yes = (o) => /^(yes|up|over)$/i.test(o) ? "up" : /^(no|down|under)$/i.test(o) ? "down" : "cyan";
    const table = h("table", {}, h("thead", {}, h("tr", {}, th("Marché"), th("Catégorie"), th("Position"), th("Taille", "size", "r"), th("Entrée", "avg", "r"), th("Cote", "price", "r"), th("24 h", "d1", "r"), th("Valeur", "value", "r"), th("PnL latent", "pnl", "r"), th("PnL %", "pct", "r"), th("Poids"))),
      h("tbody", {}, rows.map((p) => h("tr", {}, h("td", { style: "min-width:220px" }, Drawer.marketBtn(p), " ", p.slug ? mkLink("https://polymarket.com/event/" + p.slug, "↗") : null), h("td", {}, h("span", { class: "chip", style: `color:${CAT_COL[p.cat]};border-color:${CAT_COL[p.cat]}` }, p.catL)), h("td", {}, h("span", { class: "chip " + yes(p.outcome) }, p.outcome)),
        h("td", { class: "r mono" }, p.size.toLocaleString("fr-FR", { maximumFractionDigits: 0 })), h("td", { class: "r mono" }, (p.avg * 100).toFixed(1) + "¢"), h("td", { class: "r mono" }, (p.price * 100).toFixed(1) + "¢"), h("td", { class: "r mono " + cls(p.d1 || 0) }, p.d1 == null ? "–" : (p.d1 > 0 ? "+" : "") + (p.d1 * 100).toFixed(1) + " pts"),
        h("td", { class: "r mono" }, usd(p.value)), h("td", { class: "r mono " + cls(p.upnl) }, signed(p.upnl)), h("td", { class: "r mono " + cls(p.pct) }, spct(p.pct, 0)), h("td", {}, h("div", { style: "display:flex;align-items:center;gap:6px" }, h("div", { class: "bias", style: "min-width:60px;height:6px" }, h("i", { class: "l", style: `width:${V ? (p.value / V) * 100 : 0}%;background:var(--cyan)` })), h("span", { class: "mono dim", style: "font-size:.72rem" }, V ? pct(p.value / V, 1) : "–")))))));
    const search = h("input", { type: "search", class: "search", placeholder: "Rechercher un marché…", "aria-label": "Rechercher dans les positions", value: ui.q }); search.addEventListener("input", () => { ui.q = search.value.trim().toLowerCase(); const pos = search.selectionStart; render(); const n = body.querySelector("input[type=search]"); n.focus(); n.setSelectionRange(pos, pos); });
    const segCat = h("div", { class: "seg" }, cats.map((c) => h("button", { type: "button", "aria-pressed": String(ui.cat === c), onclick: () => { ui.cat = c; render(); } }, catLbl(c))));
    const posPanel = h("section", { class: "panel" }, h("div", { class: "head" }, h("h2", {}, "Positions ouvertes"), h("span", { class: "muted", style: "font-size:.8rem" }, `${rows.length} affichée${rows.length > 1 ? "s" : ""}, triées par valeur`), h("div", { class: "sp toolbar" }, search, segCat, dust ? h("button", { class: "btn" + (ui.dust ? " on" : ""), type: "button", onclick: () => { ui.dust = !ui.dust; render(); } }, `Sans valeur (${dust})`) : null)),
      h("div", { class: "body" }, rows.length ? h("div", { class: "scroll limited" }, table) : h("div", { class: "empty" }, act.length ? "Aucune position ne correspond à ce filtre." : dust ? `Aucune position active : les ${dust} positions restantes valent 0 $ (paris perdus pas encore soldés).` : "Ce compte n'a aucune position ouverte en ce moment : son capital est soldé ou en attente."), d.truncated ? h("p", { class: "disclaimer" }, "Liste limitée aux plus grosses positions de la dernière collecte.") : null));
    // ---- mouvements
    const now = Date.now(), acts = d.activity.filter((a) => now - a.t < 7 * 86400e3), LBL = { BUY: ["+ ACHAT", "up"], SELL: ["− VENTE", "down"], REDEEM: ["RÉSOLUTION", "cyan"], REWARD: ["RÉCOMPENSE", "neutral"], TAKER_REBATE: ["REMISE", "neutral"], MAKER_REBATE: ["REMISE", "neutral"], SPLIT: ["SPLIT", "neutral"], MERGE: ["FUSION", "neutral"] };
    const buy = acts.filter((a) => a.side === "BUY").reduce((s, a) => s + a.usdc, 0), sell = acts.filter((a) => a.side === "SELL").reduce((s, a) => s + a.usdc, 0), d24 = acts.filter((a) => now - a.t < 86400e3);
    const actPanel = panel("Derniers mouvements", { sub: `7 jours : ${usd(buy)} achetés · ${usd(sell)} vendus · ${d24.length}${d.activity.length >= 100 && d24.length === acts.length ? "+" : ""} opérations sur 24 h` }, acts.length ? h("div", { class: "feed", style: "max-height:420px;overflow-y:auto" }, acts.slice(0, 80).map((a) => { const [lab, tone] = LBL[a.type === "TRADE" ? a.side : a.type] || [a.type, "neutral"]; return h("div", { class: "ev compact", style: "grid-template-columns:98px minmax(0,1fr) 70px" }, h("span", { class: "chip " + tone }, lab), h("div", { class: "tx" }, a.title ? [Drawer.marketBtn({ title: a.title, slug: a.slug }), a.outcome ? [" ", h("span", { class: "chip neutral" }, a.outcome)] : null, " "] : null, h("span", { class: "mono" }, usd(a.usdc), a.price ? ` à ${(a.price * 100).toFixed(1)}¢` : "")), h("div", { class: "tm", title: new Date(a.t).toLocaleString("fr-FR") }, ago(a.t))); })) : h("div", { class: "muted" }, d.live ? "Aucun mouvement sur 7 jours." : "Historique détaillé disponible quand le navigateur peut joindre Polymarket."));
    // ---- profil de risque
    const byCat = {}; for (const p of act) byCat[p.cat] = (byCat[p.cat] || 0) + p.value;
    const parts = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ v, color: CAT_COL[c], label: catLbl(c), fmt: usd }));
    const bk = [["Asymétrie (cote < 15¢)", (p) => p.price < 0.15, "var(--rose)"], ["Conviction (15 à 50¢)", (p) => p.price >= 0.15 && p.price < 0.5, "var(--amber)"], ["Favori (50 à 85¢)", (p) => p.price >= 0.5 && p.price <= 0.85, "var(--cyan)"], ["Portage (cote > 85¢)", (p) => p.price > 0.85, "var(--mint)"]].map(([l, f, c]) => ({ l, c, v: act.filter(f).reduce((s, p) => s + p.value, 0), n: act.filter(f).length }));
    const style = !V ? "" : bk[3].v / V > 0.5 ? "Profil de portage : l'essentiel du capital est sur des issues très probables (petit gain, gros risque de queue)." : bk[0].v / V > 0.3 ? "Profil asymétrique : beaucoup de paris à faible cote (petite mise, gros gain possible)." : bk[1].v / V + bk[2].v / V > 0.6 ? "Profil de conviction : capital concentré sur des marchés encore incertains." : "Profil mixte.";
    const riskPanel = panel("Profil de risque", {}, V ? [h("div", { style: "display:flex;gap:20px;align-items:center;flex-wrap:wrap" }, Ch.donut(parts, { size: 150, thick: 18, center: usd(V) }), h("div", { class: "legend", style: "flex-direction:column" }, parts.map((p) => h("span", {}, h("i", { style: `background:${p.color}` }), p.label + " ", h("b", { class: "mono" }, pct(p.v / V))))), ),
      h("h3", { style: "margin:14px 0 8px" }, "Répartition par cote"), ...bk.map((b) => h("div", { class: "coinrow", style: "grid-template-columns:170px minmax(0,1fr) 110px" }, h("div", { style: "font-size:.8rem" }, b.l), h("div", { class: "bias", style: "height:10px" }, h("i", { class: "l", style: `width:${(b.v / V) * 100}%;background:${b.c};box-shadow:0 0 8px ${b.c}` })), h("div", { class: "mono", style: "text-align:right;font-size:.78rem" }, `${pct(b.v / V)} · ${b.n}`))), h("p", { class: "muted", style: "margin:10px 0 0;font-size:.84rem" }, style),
      h("p", { class: "dim", style: "margin:6px 0 0;font-size:.76rem" }, `Les 5 plus grosses positions pèsent ${pct([...act].sort((a, b) => b.value - a.value).slice(0, 5).reduce((s, p) => s + p.value, 0) / V)} du portefeuille.`)] : h("div", { class: "muted" }, "Pas de capital engagé actuellement."));
    const retry = h("button", { class: "btn", type: "button", onclick: () => open(addr, name) }, "Réessayer");
    const banner = d.err ? h("div", { class: "banner", style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap" }, h("span", {}, `${d.err}. ${all.length ? "Les positions affichées viennent de : " + d.src + "." : "Aucune position connue pour ce compte pour l'instant."}`), retry) : null;
    body.replaceChildren(...[head, srcLine, banner, kpis, posPanel, h("div", { class: "grid g2" }, actPanel, riskPanel)].filter(Boolean));
  }
  return { open, close, catOf };
})();
