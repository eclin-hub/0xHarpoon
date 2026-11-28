"use strict";
/* Live Whale Tape — flux continu des grosses transactions.
   Moteur (indépendant de l'affichage, il tourne quelle que soit la page ouverte) :
   - toutes les 30 s, UNE requête ramène les transactions Polymarket d'au moins 10 000 $ (filtre côté serveur) ;
   - en cas de refus ou de panne, le moteur passe en mode dégradé (nouvel essai toutes les 10 minutes) et continue d'afficher
     l'historique glissant conservé localement, complété par les mouvements issus des relevés de positions ;
   - les ordres Hyperliquid viennent du relevé de positions des comptes suivis (déjà en direct).
   Vue : filtre par montant, détection des convergences (plusieurs baleines achètent la même issue). */
const Tape = (() => {
  const LS = "wc-tape", KEEP = 24 * 3600e3, FAST = 30000, SLOW = 10 * 60e3, MIN_FETCH = 10000;
  const T = { prints: new Map(), mode: "démarrage", okAt: 0, tryAt: 0, nextAt: 0, fails: 0, err: null, added: 0, timer: 0, subs: new Set() };
  try { for (const p of JSON.parse(localStorage.getItem(LS) || "[]")) if (Date.now() - p.t < KEEP) T.prints.set(p.id, p); } catch {}
  const persist = () => { try { localStorage.setItem(LS, JSON.stringify([...T.prints.values()].sort((a, b) => b.t - a.t).slice(0, 600))); } catch {} };
  const notify = () => { for (const f of T.subs) { try { f(); } catch {} } };
  async function poll() {
    clearTimeout(T.timer); T.tryAt = Date.now();
    try {
      const rows = await PMApi.trades(MIN_FETCH, 200); let add = 0;
      for (const r of rows) { const id = (r.tx || r.t) + ":" + r.token + ":" + r.addr + ":" + r.side; if (!T.prints.has(id)) { T.prints.set(id, { id, src: "pm", ...r }); add++; } }
      for (const [k, p] of T.prints) if (Date.now() - p.t > KEEP) T.prints.delete(k);
      T.okAt = Date.now(); T.fails = 0; T.err = null; T.mode = "direct"; T.added = add; if (add) persist();
    } catch (e) { T.fails++; T.err = e?.status === 429 ? "limite de débit" : "API injoignable"; T.mode = T.fails >= 2 ? "dégradé" : "nouvel essai"; }
    const wait = T.mode === "dégradé" ? SLOW : document.hidden ? 4 * FAST : FAST; T.nextAt = Date.now() + wait; T.timer = setTimeout(poll, wait); notify();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - T.tryAt > FAST && T.mode !== "dégradé") poll(); });

  // toutes les lignes du flux : transactions Polymarket + mouvements Hyperliquid + repli sur les relevés de positions
  function rows() {
    const S = App.S, out = [...T.prints.values()], pmNames = new Map((S?.pm.whales || []).map((w) => [w.addr.toLowerCase(), w.name])), hlSet = new Set((S?.hl.accounts || []).map((a) => a.addr));
    for (const p of out) { p.followed = pmNames.has(p.addr); if (!p.name && pmNames.get(p.addr)) p.name = pmNames.get(p.addr); }
    const havePm = out.length > 0;
    for (const e of S?.events || []) {
      if (e.src === "hl") out.push({ id: "hl:" + e.t + e.addr + e.coin + e.kind, src: "hl", t: e.t, addr: e.addr, name: e.name, coin: e.coin, kind: e.kind, hside: e.side, side: (e.kind === "open" || e.kind === "add") === (e.side === "long") ? "BUY" : "SELL", usd: Math.abs(e.delta), price: e.px || null, followed: hlSet.has(e.addr), approx: true });
      else if (!havePm || !T.okAt) out.push({ id: "pmc:" + e.t + e.addr + e.title + e.outcome, src: "pm", t: e.t, addr: (e.addr || "").toLowerCase(), name: e.name, side: e.kind === "open" || e.kind === "add" ? "BUY" : "SELL", outcome: e.outcome, title: e.title, slug: e.slug, token: e.title + "|" + e.outcome, price: e.price, usd: Math.abs(e.delta), followed: true, approx: true });
    }
    return out.sort((a, b) => b.t - a.t);
  }
  // convergence : la même issue achetée par plusieurs baleines distinctes sur la fenêtre
  function clusters(list, hours, min) {
    const cut = Date.now() - hours * 3600e3, by = new Map();
    for (const p of list) { if (p.src !== "pm" || p.side !== "BUY" || p.t < cut || p.usd < min) continue; const k = p.token || p.title + "|" + p.outcome; const c = by.get(k) || { key: k, title: p.title, slug: p.slug, outcome: p.outcome, prints: [], wallets: new Set(), total: 0, sz: 0 }; c.prints.push(p); c.wallets.add(p.addr); c.total += p.usd; c.sz += p.size || (p.price ? p.usd / p.price : 0); by.set(k, c); }
    return [...by.values()].filter((c) => c.wallets.size >= 2).map((c) => ({ ...c, n: c.wallets.size, avg: c.sz ? c.total / c.sz : null, last: Math.max(...c.prints.map((p) => p.t)), followed: c.prints.some((p) => p.followed) })).sort((a, b) => b.n - a.n || b.total - a.total);
  }
  const start = () => { if (!T.timer && !T.tryAt) poll(); };
  return { state: T, rows, clusters, start, poll, onUpdate: (f) => T.subs.add(f) };
})();

App.views.tape = (() => {
  const z = {}; const f = { min: 50000, src: "all", followed: false, win: 6, q: "", page: 0 }; const PER = 50;
  try { Object.assign(f, JSON.parse(localStorage.getItem("wc-tape-ui") || "{}"), { q: "", page: 0 }); } catch {}
  const keep = () => { try { localStorage.setItem("wc-tape-ui", JSON.stringify({ min: f.min, src: f.src, followed: f.followed, win: f.win })); } catch {} };
  const hms = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), day = (t) => (Date.now() - t > 20 * 3600e3 ? new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " " : "");
  const whoBtn = (p) => h("span", {}, Drawer.walletBtn({ addr: p.addr, name: p.name }, p.src), p.followed ? h("span", { class: "chip cyan", style: "margin-left:6px", title: "Compte de l'échantillon suivi" }, "suivie") : null);
  const sideChip = (p) => p.src === "hl" ? h("span", { class: "chip " + (p.side === "BUY" ? "up" : "down") }, `${KIND[p.kind]} ${p.hside === "long" ? "LONG" : "SHORT"}`.replace("a ", "")) : h("span", { class: "chip " + (p.side === "BUY" ? "up" : "down") }, (p.side === "BUY" ? "Achat " : "Vente ") + (p.outcome || ""));
  const mkt = (p) => (p.src === "hl" ? h("b", {}, Drawer.assetBtn(p.coin)) : Drawer.marketBtn(p));
  function status() {
    const T = Tape.state, live = T.mode === "direct", s = Math.max(0, Math.round((T.nextAt - Date.now()) / 1000));
    z.status.replaceChildren(...[h("span", { class: "chip " + (live ? "up" : T.mode === "dégradé" ? "warn" : "neutral") }, live ? "direct · relevé toutes les 30 s" : T.mode === "dégradé" ? "mode dégradé · nouvel essai toutes les 10 min" : T.mode), T.okAt ? h("span", { class: "mono muted" }, "dernier relevé réussi il y a " + ago(T.okAt)) : h("span", { class: "mono muted" }, "aucun relevé direct pour l'instant"),
      T.nextAt ? h("span", { class: "mono dim" }, "prochain dans " + (s >= 90 ? Math.round(s / 60) + " min" : s + " s")) : null, T.err ? h("span", { class: "chip warn" }, T.err + " : affichage de l'historique conservé") : null, h("button", { class: "btn", type: "button", onclick: () => Tape.poll() }, "Relever maintenant")].filter(Boolean));
  }
  return {
    title: () => ["Whale ", h("em", {}, "Tape")],
    sub: "Les grosses transactions au fil de l'eau : chaque achat ou vente d'au moins 10 000 $ sur Polymarket, et les mouvements des comptes suivis sur Hyperliquid. Les convergences signalent une même issue achetée par plusieurs baleines.",
    init(box) {
      z.status = h("div", { class: "fstats", "aria-live": "polite" }); z.min = h("div", { class: "seg" }); z.src = h("div", { class: "seg" }); z.win = h("div", { class: "seg" }); z.kpis = h("div", { class: "kpis" }); z.cl = h("div", { class: "tclusters" }); z.tbl = h("div", { class: "scroll" }); z.pager = h("div", { class: "pager" }); z.count = h("span", { class: "muted", style: "font-size:.8rem" });
      z.fol = h("button", { class: "btn", type: "button", onclick: () => { f.followed = !f.followed; f.page = 0; keep(); App.refresh(); } }, "Baleines suivies seulement");
      z.search = h("input", { type: "search", class: "search", placeholder: "Filtrer : baleine, marché, actif…", "aria-label": "Filtrer le tape", oninput: (e) => { f.q = e.target.value.trim().toLowerCase(); f.page = 0; App.refresh(); } });
      box.append(z.status, h("div", { class: "toolbar" }, h("span", { class: "vlab" }, "MONTANT MINIMUM"), z.min, z.src, z.fol), z.kpis,
        panel("Convergences", { sub: "même issue achetée par plusieurs baleines distinctes", tools: z.win }, z.cl),
        h("section", { class: "panel" }, h("div", { class: "head" }, h("h2", {}, "Transactions"), z.count, h("div", { class: "sp" }, z.search)), h("div", { class: "body" }, z.tbl, z.pager)));
      Tape.onUpdate(() => { if (App.cur === "tape" && App.S) App.refresh(); }); setInterval(() => { if (App.cur === "tape") status(); }, 1000);
    },
    update() {
      status(); const set = (k) => (v) => { f[k] = v; f.page = 0; keep(); };
      seg(z.min, [[10000, "≥ 10 k$"], [25000, "≥ 25 k$"], [50000, "≥ 50 k$"], [100000, "≥ 100 k$"]], f.min, set("min")); seg(z.src, [["all", "Tout"], ["pm", "Polymarket"], ["hl", "Hyperliquid"]], f.src, set("src")); seg(z.win, [[1, "1 h"], [3, "3 h"], [6, "6 h"], [24, "24 h"]], f.win, set("win")); z.fol.classList.toggle("on", f.followed); z.fol.setAttribute("aria-pressed", String(f.followed));
      const all = Tape.rows(), list = all.filter((p) => p.usd >= f.min && (f.src === "all" || p.src === f.src) && (!f.followed || p.followed) && (!f.q || [p.name, p.addr, p.title, p.outcome, p.coin && coinName(p.coin)].some((x) => x && String(x).toLowerCase().includes(f.q))));
      const cl = Tape.clusters(all, f.win, Math.min(f.min, 25000)), inCl = new Map(); for (const c of cl) for (const p of c.prints) inCl.set(p.id, c.n);
      const w = list.filter((p) => Date.now() - p.t < f.win * 3600e3), buy = w.filter((p) => p.side === "BUY").reduce((s, p) => s + p.usd, 0), sell = w.filter((p) => p.side === "SELL").reduce((s, p) => s + p.usd, 0), big = [...w].sort((a, b) => b.usd - a.usd)[0];
      z.kpis.replaceChildren(kpi(`Transactions (${f.win} h)`, String(w.length), "au-dessus du seuil"), kpi("Achats", usd(buy), "", "up"), kpi("Ventes", usd(sell), "", "down"), kpi("Convergences", String(cl.length), `sur ${f.win} h`, cl.length ? "warn" : ""));
      z.cl.replaceChildren(...(cl.length ? cl.slice(0, 8).map((c) => h("div", { class: "tcluster" + (c.followed ? " fol" : "") }, h("div", { class: "top" }, h("span", { class: "chip warn tbadge" }, `CONVERGENCE × ${c.n} baleines`), h("b", {}, Drawer.marketBtn(c)), h("span", { class: "chip up" }, "Achat " + (c.outcome || "")), h("span", { class: "mono" }, usd(c.total)), c.avg ? h("span", { class: "mono muted" }, "prix moyen " + (c.avg * 100).toFixed(1) + "¢") : null, h("span", { class: "mono dim" }, "dernier il y a " + ago(c.last))),
        h("div", { class: "tlines" }, c.prints.sort((a, b) => b.t - a.t).slice(0, 8).map((p) => h("div", { class: "tline" }, h("span", { class: "mono dim" }, day(p.t) + hms(p.t)), whoBtn(p), h("span", { class: "mono" }, p.price != null ? (p.price * 100).toFixed(1) + "¢" : "–"), h("span", { class: "mono" }, usd(p.usd)))), c.prints.length > 8 ? h("div", { class: "dim", style: "font-size:.74rem" }, `+ ${c.prints.length - 8} autres achats`) : null))) : [empty(`Aucune issue achetée par plusieurs baleines sur ${f.win} h au-dessus de ${usd(Math.min(f.min, 25000))}.`)]));
      const pages = Math.max(1, Math.ceil(list.length / PER)); if (f.page >= pages) f.page = pages - 1; z.count.textContent = `${list.length} transaction${list.length > 1 ? "s" : ""} sur 24 h`;
      z.tbl.replaceChildren(list.length ? h("table", { class: "ttable" }, h("thead", {}, h("tr", {}, ["Heure", "Baleine", "Marché ou actif", "Sens", "Prix", "Montant"].map((t, i) => h("th", { class: i === 4 || i === 5 ? "r" : "" }, t)))), h("tbody", {}, list.slice(f.page * PER, f.page * PER + PER).map((p) => h("tr", { class: inCl.has(p.id) ? "tconv" : "" }, h("td", { class: "mono", title: new Date(p.t).toLocaleString("fr-FR") }, day(p.t) + hms(p.t)), h("td", {}, whoBtn(p)), h("td", { style: "min-width:200px" }, mkt(p), " ", h("span", { class: "chip neutral" }, p.src === "hl" ? "HL" : "PM"), inCl.has(p.id) ? h("span", { class: "chip warn", style: "margin-left:4px", title: "convergence : plusieurs baleines sur la même issue" }, "× " + inCl.get(p.id)) : null, p.approx ? h("span", { class: "chip neutral", title: "Mouvement déduit d'un relevé de positions : heure et prix approximatifs", style: "margin-left:4px" }, "relevé") : null), h("td", {}, sideChip(p)),
        h("td", { class: "r mono" }, p.price == null ? "–" : p.src === "hl" ? px(p.price) : (p.price * 100).toFixed(1) + "¢"), h("td", { class: "r mono " + (p.usd >= 100000 ? "warn" : "") }, usd(p.usd)))))) : empty(all.length ? "Aucune transaction avec ces filtres : baissez le montant minimum." : "En attente du premier relevé. Si l'API est injoignable depuis cette page, le flux se remplit avec les relevés de positions."));
      const go = (n) => { f.page = n; App.refresh(); z.tbl.scrollIntoView({ behavior: "smooth", block: "start" }); };
      z.pager.replaceChildren(...(pages > 1 ? [h("button", { class: "btn", type: "button", disabled: f.page === 0 ? "" : null, onclick: () => go(f.page - 1) }, "← Précédent"), h("span", { class: "mono muted", style: "align-self:center" }, `page ${f.page + 1} / ${pages}`), h("button", { class: "btn", type: "button", disabled: f.page >= pages - 1 ? "" : null, onclick: () => go(f.page + 1) }, "Suivant →")] : []));
    },
  };
})();
