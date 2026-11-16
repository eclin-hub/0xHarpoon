"use strict";
/* QuantVault — page annexe « RESTRICTED QUANT & FACTOR LAB ».
   Architecture : un en-tête unique et mince, un graphique par onglet sur toute la hauteur (ou mosaïque), mode plein écran par graphique.
   Les outils sont montés UNE fois puis seulement masqués : leur état (rotation 3D, positions du réseau, simulations, caches) et l'état
   du modèle Q survivent à tout changement de vue. Les flux de données (Live, Tape, collecte) tournent ailleurs et ne dépendent pas de l'affichage. */
const Vault = (() => {
  const A = QM.ASSETS, pc = (x, d = 1) => (x * 100).toFixed(d) + " %";
  const Q = { w: QM.PRESETS.barbell(), preset: "barbell", lev: 1, hedge: 0, s: 0.15, scenKey: "none", scen: QM.SCEN.none, st: null, pf: null };
  const SHORT = { sankey: "Sankey", frontier: "Frontière 3D", robust: "Robustesse", mst: "Contagion", heat: "Corrélations", cones: "Cônes à sauts", beta: "Bêta 3D", hidden: "Facteurs cachés", t8: "DFM · Kalman", t9: "Fama-MacBeth", t10: "GJR-GARCH" };
  let root = null, open = false, raf = 0, dirty = true, views = [], cur = "sankey", mosaic = false, focus = null, thesis = null, z = {};
  try { const sv = JSON.parse(localStorage.getItem("wc-vault") || "null"); if (sv?.w?.length === QM.N) Object.assign(Q, { w: sv.w, preset: sv.preset, lev: sv.lev, hedge: sv.hedge, s: sv.s, scenKey: sv.scenKey, scen: QM.SCEN[sv.scenKey] || QM.SCEN.none }); if (sv?.cur) cur = sv.cur; if (sv?.mosaic) mosaic = true; } catch {}
  const persist = () => { try { localStorage.setItem("wc-vault", JSON.stringify({ w: Q.w, preset: Q.preset, lev: Q.lev, hedge: Q.hedge, s: Q.s, scenKey: Q.scenKey, cur, mosaic })); } catch {} };
  function recompute() { Q.st = QM.state(Q.s, Q.scen); Q.pf = QM.portfolio(Q.w, Q.lev, Q.hedge, Q.st); dirty = true; persist(); kpis(); }
  const stressName = () => (Q.s < 0.2 ? "calme" : Q.s < 0.5 ? "tension" : Q.s < 0.8 ? "stress sévère" : "crise systémique");

  function kpis() {
    if (!z.kpis) return; const p = Q.pf, K = (l, v, s, c) => h("div", { class: "qkpi" }, h("span", {}, l), h("b", { class: "mono " + (c || "") }, v), s ? h("small", {}, s) : null);
    z.kpis.replaceChildren(K("Rendement espéré annuel", (p.mu >= 0 ? "+" : "") + pc(p.mu), "net du coût du levier et des puts", p.mu >= 0 ? "up" : "down"), K("Volatilité factorielle / totale", `${pc(p.volF, 0)} / ${pc(p.vol, 0)}`, `${pc(1 - p.idioShare, 0)} du risque est systématique`), K("VaR 99 % (1 mois)", "−" + pc(p.var99), "perte dépassée 1 mois sur 100", "down"),
      K("Expected Shortfall 99 % (1 mois)", "−" + pc(p.es), Q.hedge > 0 ? `sans puts : −${pc(p.esRaw)}` : "perte moyenne au-delà de la VaR", "down"), K("Entropie factorielle (Shannon)", pc(p.entropy, 0), p.entropy > 0.85 ? "risque bien réparti" : p.entropy > 0.65 ? "concentration modérée" : "un facteur domine", p.entropy > 0.85 ? "up" : p.entropy > 0.65 ? "warn" : "down"),
      K("Probabilité d'appel de marge", Q.lev > 1 ? pc(p.pMargin, p.pMargin < 0.01 ? 2 : 1) : "0 %", Q.lev > 1 ? `seuil : perte de ${pc(p.margin, 0)} en 1 mois` : "pas de levier", p.pMargin > 0.05 ? "down" : ""));
    // résumé permanent de l'en-tête mince et des commandes flottantes
    z.mini.replaceChildren(...[h("span", { title: "Rendement espéré annuel" }, "μ ", h("b", { class: "mono " + (p.mu >= 0 ? "up" : "down") }, (p.mu >= 0 ? "+" : "") + pc(p.mu, 0))), h("span", { title: "Expected Shortfall 99 % à 1 mois" }, "ES ", h("b", { class: "mono down" }, "−" + pc(p.es, 0))), h("span", { title: "Entropie factorielle" }, "H ", h("b", { class: "mono" }, pc(p.entropy, 0))), Q.lev > 1 ? h("span", { title: "Probabilité d'appel de marge" }, "marge ", h("b", { class: "mono " + (p.pMargin > 0.05 ? "down" : "") }, pc(p.pMargin, 1))) : null].filter(Boolean));
    for (const el of [z.stressLbl, z.fStressLbl]) if (el) el.textContent = Math.round(Q.s * 100) + " % · " + stressName();
    for (const el of [z.stress, z.fStress, z.sStress]) if (el && document.activeElement !== el) el.value = Math.round(Q.s * 100);
    for (const box of [z.presets, z.fPresets]) if (box) for (const b of box.children) b.setAttribute("aria-pressed", String(b.dataset.k === Q.preset));
    for (const b of z.scens.children) b.setAttribute("aria-pressed", String(b.dataset.k === Q.scenKey));
    z.wsl.forEach((r, i) => { if (document.activeElement !== r.i) r.i.value = Math.round(Q.w[i] * 1000) / 10; r.o.textContent = pc(Q.w[i]); }); z.levO.textContent = Q.lev.toFixed(1) + "×"; if (document.activeElement !== z.lev) z.lev.value = Q.lev; z.hedO.textContent = pc(Q.hedge); if (document.activeElement !== z.hed) z.hed.value = Q.hedge * 100;
  }

  /* ---------- dimensionnement : le graphique occupe la hauteur disponible ---------- */
  function sizeView(v) {
    const cvs = [...v.sec.querySelectorAll("canvas")]; if (!cvs.length) return; const full = focus === v.id;
    if (cvs.length === 1 && !mosaic || cvs.length === 1 && full) { const c = cvs[0], sc = full ? v.sec : z.scroll, top = c.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop, cap = (c._cap?.offsetHeight || 0) + 40, below = [...c.parentElement.children].filter((e) => e !== c && e !== c._cap && e.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING).reduce((s, e) => s + e.offsetHeight + 8, 0);
      c._h = Math.round(Math.max(320, Math.min(1500, sc.clientHeight - top - cap - below))); }
    else for (const c of cvs) { c._h0 ??= c._h; c._h = Math.round(c._h0 * (full ? Math.max(1, Math.min(1.8, (window.innerHeight - 260) / (c._h0 * (v.rows || 1)))) : 1)); }
  }
  const visible = (v) => (focus ? focus === v.id : mosaic || v.id === cur);
  function frame() {
    raf = open ? requestAnimationFrame(frame) : 0; if (!open) return; const vis = views.filter(visible);
    if (dirty) { dirty = false; let th = false; for (const v of vis) { sizeView(v); if (v.thesis) th = true; else if (!v.tick) { try { v.draw(); } catch (e) { console.error("outil " + v.id, e); } } } if (th && thesis) { try { thesis.draw(); } catch (e) { console.error("laboratoire", e); } } }
    for (const v of vis) if (v.tick) { try { v.tick(); } catch (e) { console.error("outil " + v.id, e); } }
  }
  function layout() {
    for (const v of views) { v.sec.hidden = !visible(v); v.sec.classList.toggle("qsolo", !mosaic && !focus); v.sec.classList.toggle("qfocus", focus === v.id); v.tab.setAttribute("aria-selected", String(!mosaic && v.id === cur)); v.fsBtn.textContent = focus === v.id ? "✕ Quitter le plein écran" : "⛶ Plein écran"; }
    z.lab.classList.toggle("mosaic", mosaic && !focus); z.mosBtn.setAttribute("aria-pressed", String(mosaic)); const th = views.find((v) => v.id === cur)?.thesis && !mosaic; z.thesisHead.hidden = !(th || (mosaic && !focus)); z.thesisWarn.hidden = z.thesisHead.hidden;
    z.float.hidden = !focus; if (focus) views.find((v) => v.id === focus).sec.append(z.float); dirty = true; persist();
  }
  function show(id) { if (focus) exitFocus(); mosaic = false; cur = id; layout(); z.scroll.scrollTop = 0; views.find((v) => v.id === id)?.tab.scrollIntoView({ block: "nearest", inline: "center" }); }
  function enterFocus(id) { focus = id; layout(); const sec = views.find((v) => v.id === id).sec; if (sec.requestFullscreen) sec.requestFullscreen().catch(() => {}); }   // repli : le mode focus en CSS suffit si le plein écran natif est refusé
  function exitFocus() { if (!focus) return; focus = null; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); layout(); }
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && focus) { focus = null; layout(); } dirty = true; });
  // export : dans un artefact Claude, passe par la capacité « downloads » (seule voie autorisée) ; ailleurs, téléchargement classique
  async function download(name, text, type) {
    const dl = window.claude?.use ? await window.claude.use("downloads").catch(() => null) : null;
    if (dl) { try { const r = await dl.save({ filename: name, data: text }); if (r?.status) toast("Fichier " + name + (r.status === "saved" ? " enregistré" : " transmis"), "ok"); } catch (e) { if (e?.code !== "dismissed" && e?.code !== "declined") toast("Export refusé ou indisponible (" + (e?.code || "erreur") + ")", "err"); } return; }
    try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast("Fichier " + name + " généré", "ok"); } catch { navigator.clipboard?.writeText(text).then(() => toast("Téléchargement bloqué ici : contenu copié dans le presse-papiers", "ok")).catch(() => toast("Export impossible depuis cette page", "err")); } }

  function build() {
    const sld = (min, max, step, val, on, lab) => { const i = h("input", { type: "range", min, max, step, value: val, "aria-label": lab }); i.addEventListener("input", () => on(Number(i.value))); return i; };
    const setS = (v) => { Q.s = v / 100; recompute(); }, presetBtns = () => h("div", { class: "seg" }, [["barbell", "Barbell macro"], ["tech", "Tech & croissance"], ["parity", "Risk parity factoriel"], ["equal", "Équipondéré 1/N"]].map(([k, l]) => h("button", { type: "button", "data-k": k, onclick: () => { Q.w = QM.PRESETS[k](); Q.preset = k; recompute(); } }, l)));
    z.kpis = h("div", { class: "qkpis" }); z.mini = h("div", { class: "vmini-k" }); z.stressLbl = h("b", { class: "mono" }); z.fStressLbl = h("b", { class: "mono" });
    z.stress = sld(0, 100, 1, Q.s * 100, setS, "Tension de queue"); z.sStress = sld(0, 100, 1, Q.s * 100, setS, "Tension de queue"); z.fStress = sld(0, 100, 1, Q.s * 100, setS, "Tension de queue");
    z.presets = presetBtns(); z.fPresets = presetBtns();
    z.scens = h("div", { class: "seg" }, [["none", "Sans choc", null], ["oil", "Choc pétrole & gaz", 0.7], ["rates", "Krach taux & tech", 0.75], ["liq", "Crise de liquidité", 0.95]].map(([k, l, s]) => h("button", { type: "button", "data-k": k, onclick: () => { Q.scenKey = k; Q.scen = QM.SCEN[k]; if (s != null) Q.s = s; recompute(); } }, l)));
    z.wsl = A.map((a, i) => { const o = h("b", { class: "mono" }), inp = sld(0, 40, 0.5, Q.w[i] * 100, (v) => { const w = [...Q.w]; w[i] = v / 100; const rest = w.reduce((s, x, j) => s + (j === i ? 0 : x), 0), tgt = 1 - w[i]; Q.w = rest > 1e-9 ? w.map((x, j) => (j === i ? x : x * tgt / rest)) : QM.norm(w.map((x, j) => (j === i ? x : 1e-6))); Q.preset = "custom"; recompute(); }, "Poids " + a.t); return { i: inp, o, el: h("label", { class: "qslider" }, h("span", {}, h("i", { class: "qdot", style: `background:${QM.CLS_COL[a.cls]}` }), a.t + " ", o), inp) }; });
    z.levO = h("b", { class: "mono" }); z.lev = sld(1, 5, 0.1, Q.lev, (v) => { Q.lev = v; recompute(); }, "Levier"); z.hedO = h("b", { class: "mono" }); z.hed = sld(0, 10, 0.25, Q.hedge * 100, (v) => { Q.hedge = v / 100; recompute(); }, "Budget de puts");
    // panneau de réglages : se déplie au-dessus du contenu, sans réduire la hauteur des graphiques
    z.settings = h("div", { class: "vsettings", hidden: "" }, h("div", { class: "vrow" }, h("span", { class: "vlab" }, "ALLOCATION"), z.presets, h("span", { class: "vlab" }, "SCÉNARIO"), z.scens), h("label", { class: "vstress" }, h("span", {}, "TENSION DE QUEUE / STRESS CYGNE NOIR ", z.stressLbl), z.sStress), z.kpis,
      h("div", { class: "qgrid" }, h("label", { class: "qslider" }, h("span", {}, "Levier ", z.levO), z.lev), h("label", { class: "qslider" }, h("span", {}, "Budget de puts hors de la monnaie (par an) ", z.hedO), z.hed)), h("div", { class: "qgrid" }, z.wsl.map((r) => r.el)),
      h("p", { class: "qnote" }, "Modèle stylisé et données simulées, sauf mention contraire. Cette page n'est pas protégée par mot de passe : son code est public si le site l'est. Les poids sont renormalisés à 100 %. Puts : un budget de 4 % par an couvre toute perte mensuelle au-delà de 10 % ; en dessous, la couverture est partielle. Levier financé à 4 % ; appel de marge quand les fonds propres tombent sous 15 % de l'exposition."));
    z.setBtn = h("button", { class: "btn", type: "button", "aria-expanded": "false", onclick: () => { z.settings.hidden = !z.settings.hidden; z.setBtn.setAttribute("aria-expanded", String(!z.settings.hidden)); z.setBtn.classList.toggle("on", !z.settings.hidden); } }, "⚙️ Réglages");
    z.tabs = h("div", { class: "vtabs", role: "tablist", "aria-label": "Graphiques" }); z.mosBtn = h("button", { class: "btn", type: "button", "aria-pressed": "false", title: "Afficher tous les graphiques", onclick: () => { if (focus) exitFocus(); mosaic = !mosaic; layout(); } }, "▦ Mosaïque");
    z.exp = h("div", { class: "toolbar" }, h("button", { class: "btn", type: "button", onclick: () => download("factor-lab-diagnostics.json", JSON.stringify(QTH.exportData(Q), null, 2), "application/json") }, "📸 Exporter JSON"), h("button", { class: "btn", type: "button", onclick: () => download("factor-lab-diagnostics.csv", "﻿" + QTH.toCSV(QTH.exportData(Q)), "text/csv") }, "📸 Exporter CSV"));
    z.thesisHead = h("div", { class: "qbanner", hidden: "" }, h("div", {}, h("h2", {}, "🎓 LABORATOIRE ÉCONOMÉTRIQUE // MÉMOIRE"), h("p", {}, "Modèles à facteurs dynamiques, pricing en coupe transversale et Factor-GJR-GARCH")), z.exp); z.thesisWarn = h("div", { hidden: "" });
    z.lab = h("div", { class: "qtools" }); z.scroll = h("div", { class: "vscroll" }, z.thesisHead, z.thesisWarn, z.lab);
    // commandes flottantes du mode plein écran
    const fbody = h("div", { class: "qfloat-body" }, h("label", { class: "vstress" }, h("span", {}, "STRESS ", z.fStressLbl), z.fStress), z.fPresets);
    z.float = h("div", { class: "qfloat", hidden: "" }, h("button", { class: "btn", type: "button", "aria-expanded": "true", onclick: (e) => { fbody.hidden = !fbody.hidden; e.currentTarget.setAttribute("aria-expanded", String(!fbody.hidden)); e.currentTarget.textContent = fbody.hidden ? "⚙️ Commandes" : "▾ Replier"; } }, "▾ Replier"), fbody);
    root = h("div", { class: "vault", id: "vault", hidden: "" },
      h("header", { class: "vmini" }, h("button", { class: "vlock open", type: "button", onclick: close, title: "Refermer le Vault et revenir au Whale Tracker" }, "🔓 QUANT VAULT"), h("button", { class: "btn vback", type: "button", onclick: close }, "← Whale Tracker"), z.tabs, z.mosBtn,
        h("label", { class: "vmini-s", title: "Tension de queue / stress cygne noir" }, h("span", { class: "vlab" }, "STRESS"), z.stress), z.mini, z.setBtn), z.settings, z.scroll, z.float);
    document.body.append(root);
    const add = (id, n, title, sub, host, o) => { const fsBtn = h("button", { class: "btn qfs", type: "button", onclick: () => (focus === id ? exitFocus() : enterFocus(id)) }, "⛶ Plein écran"), sec = h("section", { class: "qpanel", "data-id": id }, h("div", { class: "qhead" }, h("span", { class: "qnum" }, n), h("div", { style: "flex:1;min-width:0" }, h("h3", {}, title), sub ? h("p", {}, sub) : null), fsBtn), host);
      const tab = h("button", { class: "vtab", type: "button", role: "tab", onclick: () => show(id) }, h("b", {}, n), " " + (SHORT[id] || title)); z.tabs.append(tab); z.lab.append(sec); const v = { id, sec, tab, fsBtn, ...o }; views.push(v); return v; };
    for (const t of QT.LIST) { const host = h("div", { class: "qhost" }), inst = t.mount(host, Q); add(t.id, t.n, t.title, t.sub, host, { draw: inst.draw, tick: inst.tick, rows: inst.multi ? 2 : 1 }); }
    // laboratoire du mémoire : monté une fois, ses trois outils deviennent trois onglets
    const th = h("div", {}); thesis = QTH.mount(th, Q); const kids = [...th.children]; z.thesisWarn.append(kids.find((k) => k.classList.contains("qwarn")) || "");
    kids.filter((k) => k.classList.contains("qpanel")).forEach((sec, i) => { const id = "t" + (8 + i), fsBtn = h("button", { class: "btn qfs", type: "button", onclick: () => (focus === id ? exitFocus() : enterFocus(id)) }, "⛶ Plein écran"); sec.querySelector(".qhead").append(fsBtn); sec.dataset.id = id; const tab = h("button", { class: "vtab thesis", type: "button", role: "tab", onclick: () => show(id) }, h("b", {}, 8 + i), " " + SHORT[id]); z.tabs.append(tab); z.lab.append(sec); views.push({ id, sec, tab, fsBtn, thesis: true, rows: i === 0 ? 1 : 2 }); });
    if (!views.some((v) => v.id === cur)) cur = views[0].id;
    new ResizeObserver(() => (dirty = true)).observe(z.scroll); window.addEventListener("resize", () => (dirty = true));
    for (const f of ["Unbounded", "Martian Mono"]) document.fonts?.load(`12px "${f}"`).then(() => (dirty = true)).catch(() => {});
  }
  function showVault() { if (!root) build(); open = true; root.hidden = false; document.documentElement.classList.add("vault-open"); recompute(); layout(); if (!raf) raf = requestAnimationFrame(frame); root.querySelector(".vlock").focus(); sync(); }
  function close() { if (focus) exitFocus(); open = false; if (root) root.hidden = true; document.documentElement.classList.remove("vault-open"); Ch.hideTip(); sync(); $("vaultBtn")?.focus(); }
  function sync() { const b = $("vaultBtn"); if (!b) return; b.classList.toggle("open", open); b.textContent = open ? "🔓 QUANT VAULT // FACTOR & RISK LAB" : "🔒 QUANT VAULT [LOCKED]"; b.setAttribute("aria-pressed", String(open)); }
  function toggle() { if (open) return close(); const b = $("vaultBtn"); b.classList.add("unlocking"); b.textContent = "🔓 DÉVERROUILLAGE…"; setTimeout(() => { b.classList.remove("unlocking"); showVault(); }, 380); }
  function install() { const box = document.querySelector(".refresh-box"); if (!box || $("vaultBtn")) return; box.after(h("div", { class: "vault-box" }, h("button", { class: "vlock", id: "vaultBtn", type: "button", "aria-pressed": "false", onclick: toggle }, "🔒 QUANT VAULT [LOCKED]"))); }
  document.addEventListener("keydown", (e) => { if (e.key !== "Escape" || !open || document.querySelector(".drawer:not([hidden]), .pmw:not([hidden])")) return; if (focus) exitFocus(); else if (!z.settings.hidden) z.setBtn.click(); else close(); });
  install();
  return { toggle, show: showVault, close, Q, goto: show, _views: () => views.map((v) => v.id) };
})();
