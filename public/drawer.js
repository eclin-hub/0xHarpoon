"use strict";
/* Panneau latéral : fiche portefeuille, fiche actif, fiche marché Polymarket. Ouvert depuis n'importe quel nom, actif ou marché cliquable. */
const Drawer = (() => {
  let root, body, lastFocus, stack = [];
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  function ensure() {
    if (root) return;
    body = h("div", { class: "dr-body" });
    root = h("div", { class: "drawer", hidden: "", role: "dialog", "aria-modal": "true", "aria-labelledby": "drT" },
      h("div", { class: "dr-scrim", onclick: close }),
      h("aside", { class: "dr-panel" }, h("div", { class: "dr-top" }, h("button", { class: "btn", type: "button", id: "drBack", onclick: back, hidden: "" }, "← retour"), h("button", { class: "btn", type: "button", id: "drClose", onclick: close, "aria-label": "Fermer" }, "Fermer ✕")), body));
    root.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    document.body.append(root);
  }
  function show(render, push = true) {
    ensure(); if (root.hidden) { lastFocus = document.activeElement; stack = []; }
    if (push) stack.push(render);
    $("drBack").hidden = stack.length < 2;
    body.replaceChildren(...[render()].flat()); root.hidden = false; body.scrollTop = 0; $("drClose").focus();
  }
  function back() { stack.pop(); const r = stack.at(-1); if (r) show(r, false); }
  function close() { if (!root || root.hidden) return; root.hidden = true; stack = []; Ch.hideTip(); lastFocus?.focus?.(); }
  const head = (title, sub, ...extra) => h("div", { class: "dr-head" }, h("h2", { id: "drT" }, title), sub ? h("div", { class: "muted", style: "font-size:.8rem" }, sub) : null, ...extra);
  const section = (title, ...kids) => h("section", { class: "dr-sec" }, h("h3", {}, title), ...kids);
  const evList = (evs) => evs.length ? h("div", { class: "feed" }, evs.slice(0, 15).map((e) => evRow(e, false, true))) : h("div", { class: "muted" }, "Aucun mouvement détecté récemment.");

  /* ---------- liens cliquables réutilisables ---------- */
  const stop = (fn) => (e) => { e.stopPropagation(); e.preventDefault(); fn(); };
  const walletBtn = (w, src, label) => h("button", { type: "button", class: "lnk", title: "Voir le portefeuille", onclick: stop(() => wallet(w.addr, src, w.name)) }, label ?? (w.name && !/^0x/i.test(w.name) ? w.name : sh(w.addr)));
  const assetBtn = (coin, label) => h("button", { type: "button", class: "lnk mono", title: "Qui détient cet actif ?", onclick: stop(() => asset(coin)) }, label ?? coinName(coin));
  const marketBtn = (p) => h("button", { type: "button", class: "lnk", title: "Qui est positionné sur ce marché ?", onclick: stop(() => market(p.title, p.slug)) }, p.title);

  /* ---------- récupération directe des portefeuilles (navigateur) ---------- */
  async function fetchHl(addr) {
    if (typeof Live !== "undefined" && Live.account) return Live.account(addr);
    const r = await fetch("/api/hl/account?addr=" + addr); if (!r.ok) throw new Error(); return r.json();
  }
  /* ---------- fiche portefeuille ---------- */
  function wallet(addr, src, name) {
    if (src === "pm" && typeof PMWhale !== "undefined") { close(); return PMWhale.open(addr, name); }   // inspecteur complet Polymarket
    show(() => {
      const S = App.S, evs = (S?.events || []).filter((e) => e.addr === addr);
      if (src === "pm") {
        const w = S?.pm.whales.find((x) => x.addr === addr), box = h("div", {});
        const fill = (list) => box.replaceChildren(pmPositions(list));
        fill(w?.positions || []);
        return [head(name || w?.name || sh(addr), "Polymarket · " + sh(addr), h("div", { class: "chips", style: "margin-top:8px" }, w ? h("span", { class: "chip " + (w.pnlMonth >= 0 ? "up" : "down") }, "PnL mois " + signed(w.pnlMonth)) : null, w ? h("span", { class: "chip neutral" }, "exposé " + usd(w.total)) : null, (w?.cats || []).map((c) => h("span", { class: "chip neutral" }, c)), mkLink("https://polymarket.com/profile/" + addr, "Ouvrir sur Polymarket ↗", "chip cyan"))),
          section("Positions ouvertes", box), section("Derniers mouvements", evList(evs))];
      }
      const a = S?.hl.accounts.find((x) => x.addr === addr), box = h("div", {});
      const fill = (d) => box.replaceChildren(h("div", { class: "chips", style: "margin-bottom:10px" }, h("span", { class: "chip neutral" }, "capital " + usd(d.equity || 0)), h("span", { class: "chip up" }, "long " + usd(d.longN || 0)), h("span", { class: "chip down" }, "short " + usd(d.shortN || 0))), hlPositions(d.positions));
      if (a) fill(a); else { box.append(h("div", { class: "muted" }, "Chargement du portefeuille…")); fetchHl(addr).then(fill).catch(() => box.replaceChildren(h("div", { class: "muted" }, "Impossible de charger ce portefeuille ici. Ouvrez-le sur Hypurrscan."))); }
      return [head(name || a?.name || sh(addr), "Hyperliquid · " + sh(addr), h("div", { class: "chips", style: "margin-top:8px" }, a?.month ? h("span", { class: "chip " + (a.month.pnl >= 0 ? "up" : "down") }, "PnL mois " + signed(a.month.pnl) + " · " + spct(a.month.roi)) : null, a?.allTime ? h("span", { class: "chip neutral" }, "PnL total " + signed(a.allTime.pnl)) : null, a ? h("span", { class: "chip cyan" }, "dans l'échantillon suivi") : h("span", { class: "chip neutral" }, "hors échantillon"), mkLink("https://hypurrscan.io/address/" + addr, "Hypurrscan ↗", "chip cyan"))),
        section("Positions ouvertes", box), section("Derniers mouvements", evList(evs))];
    });
  }

  /* ---------- fiche actif : qui le détient ---------- */
  function asset(coin) {
    show(() => {
      const S = App.S, m = marketMap()[coin], s = S?.sentiment.find((x) => x.coin === coin);
      const rows = (S?.hl.accounts || []).flatMap((a) => a.positions.filter((p) => p.coin === coin).map((p) => ({ ...p, addr: a.addr, name: a.name })));
      const longs = rows.filter((r) => r.side === "long").sort((a, b) => b.notional - a.notional), shorts = rows.filter((r) => r.side === "short").sort((a, b) => b.notional - a.notional);
      const L = longs.reduce((x, r) => x + r.notional, 0), Sh = shorts.reduce((x, r) => x + r.notional, 0);
      const holder = (r) => h("div", { class: "orow" }, h("span", {}, walletBtn(r, "hl"), h("span", { class: "dim mono", style: "font-size:.72rem" }, `  ${r.lev ? r.lev + "× · " : ""}entrée ${px(r.entry)}`)), h("span", { class: "mono" }, usd(r.notional), " ", h("span", { class: cls(r.upnl) }, signed(r.upnl))));
      const list = (arr) => arr.length ? h("div", { class: "feed" }, arr.slice(0, 25).map(holder)) : h("div", { class: "muted" }, "Personne dans l'échantillon.");
      const evs = (S?.events || []).filter((e) => e.coin === coin);
      return [head(coinName(coin), m ? `${px(m.mark)} · ${spct(m.chg, 1)} sur 24 h · funding ${spct(fundingAnn(m), 1)}/an · OI ${usd(m.oi)}` : "", h("div", { class: "chips", style: "margin-top:8px" }, h("span", { class: "chip up" }, `${longs.length} long · ${usd(L)}`), h("span", { class: "chip down" }, `${shorts.length} short · ${usd(Sh)}`), s ? h("span", { class: "chip " + toneOf(s.score).replace("muted", "neutral") }, `sentiment ${spct(s.score)}`) : null),
        h("div", { class: "toolbar", style: "margin-top:10px" }, h("button", { class: "btn", type: "button", onclick: () => { ui.calc.coin = coin; save(); close(); location.hash = "calc"; } }, "Calculer une position"), h("button", { class: "btn", type: "button", onclick: () => { ui.liqCoin = coin; save(); close(); location.hash = "liq"; } }, "Voir les liquidations"))),
        h("div", { style: "margin:10px 0" }, bias(L, Sh)),
        section("Baleines long", list(longs)), section("Baleines short", list(shorts)),
        s?.pm && (s.pm.bullW.length || s.pm.bearW.length) ? section("Paris Polymarket liés", h("div", { class: "feed" }, [...s.pm.bullW.map((w) => ({ ...w, dir: 1 })), ...s.pm.bearW.map((w) => ({ ...w, dir: -1 }))].slice(0, 10).map((w) => h("div", { class: "orow" }, h("span", {}, walletBtn(w, "pm"), " ", h("span", { class: "chip " + (w.dir > 0 ? "up" : "down") }, w.dir > 0 ? "haussier" : "baissier"), h("span", { class: "dim", style: "font-size:.74rem" }, " " + (w.items[0]?.title || ""))), h("span", { class: "mono" }, usd(w.value)))))) : null,
        section("Derniers mouvements sur l'actif", evList(evs))];
    });
  }

  /* ---------- fiche marché Polymarket : qui est positionné ---------- */
  function market(title, slug) {
    show(() => {
      const S = App.S, rows = (S?.pm.whales || []).flatMap((w) => w.positions.filter((p) => p.title === title).map((p) => ({ ...p, addr: w.addr, name: w.name })));
      const by = {}; for (const r of rows) (by[r.outcome] ??= []).push(r);
      const evs = (S?.events || []).filter((e) => e.src === "pm" && e.title === title);
      return [head(title, `${rows.length} baleine${rows.length > 1 ? "s" : ""} suivie${rows.length > 1 ? "s" : ""} positionnée${rows.length > 1 ? "s" : ""}`, h("div", { class: "chips", style: "margin-top:8px" }, slug ? mkLink("https://polymarket.com/event/" + slug, "Ouvrir sur Polymarket ↗", "chip cyan") : null)),
        ...(rows.length ? Object.entries(by).sort((a, b) => b[1].reduce((s, r) => s + r.value, 0) - a[1].reduce((s, r) => s + r.value, 0)).map(([o, rs]) => section(`« ${o} » · ${rs.length} baleine${rs.length > 1 ? "s" : ""} · ${usd(rs.reduce((s, r) => s + r.value, 0))}`, h("div", { class: "feed" }, rs.sort((a, b) => b.value - a.value).map((r) => h("div", { class: "orow" }, h("span", {}, walletBtn(r, "pm"), h("span", { class: "dim mono", style: "font-size:.72rem" }, `  acheté ${(r.avg * 100 || 0).toFixed(0)}¢ · vaut ${(r.price * 100).toFixed(0)}¢`)), h("span", { class: "mono" }, usd(r.value), " ", h("span", { class: cls(r.pnl) }, signed(r.pnl)))))))) : [h("div", { class: "muted" }, "Aucune baleine suivie n'a de position ouverte sur ce marché.")]),
        section("Derniers mouvements sur ce marché", evList(evs))];
    });
  }
  return { wallet, asset, market, walletBtn, assetBtn, marketBtn, close };
})();
