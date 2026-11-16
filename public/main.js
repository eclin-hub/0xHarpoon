"use strict";
/* Démarrage : navigation, flux temps réel (SSE), alertes. */
let audioCtx;
function beep() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = "sine"; o.frequency.value = 880; g.gain.value = 0.06; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25); o.stop(audioCtx.currentTime + 0.26); } catch {}
}
function alerts(S) {
  const fresh = S.events.filter((e) => e.t > (App.alertT || 0));
  if (S.events.length) App.alertT = S.events[0].t;
  if (App.firstState) return;
  const big = fresh.filter((e) => (e.src === "hl" ? e.notional >= 1e6 : e.notional >= 25000));
  if (big.length && ui.flux.sound) beep();
  if (big.length && ui.flux.notif && "Notification" in window && Notification.permission === "granted") {
    const e = big[0]; try { new Notification(e.src === "hl" ? `${e.name || "Baleine"} · ${e.side.toUpperCase()} ${coinName(e.coin)}` : `${e.name || "Baleine"} · ${e.outcome}`, { body: e.src === "hl" ? `${KIND[e.kind]} ${usd(Math.abs(e.delta))}` : `${e.title} (${usd(Math.abs(e.delta))})` }); } catch {}
  }
  if (App.cur !== "flux") badge(S.events.filter((e) => e.t > App.seenEv).length);
}
function accept(S) {
  App.S = S; alerts(S);
  const errs = Object.keys(S.errors || {}); $("banner").hidden = !errs.length;
  if (errs.length) $("banner").textContent = "Source indisponible pour le moment : " + errs.join(", ") + ". Les dernières données connues restent affichées.";
  const v = App.views[App.cur]; if (v && App.inited[App.cur]) App.keep(() => v.update(S));
  App.firstState = false; tick();
}
function tick() {
  const S = App.S; if (!S) return;
  if (App.PAGES && typeof Live !== "undefined" && Live.state.posAt) { $("liveTxt").textContent = (App.liveOk ? "direct · " : "direct interrompu · ") + "positions il y a " + ago(Live.state.posAt); $("dot").classList.toggle("on", !!App.liveOk); }
  else $("liveTxt").textContent = App.SNAP ? (App.PAGES ? "en ligne · données de " : "instantané · ") + new Date(S.updatedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "en direct · " + ago(S.updatedAt);
  const age = Math.round((Date.now() - S.updatedAt) / 1000), a = $("refreshAge");
  const last = Math.max(App.checkedAt || 0, typeof Live !== "undefined" ? Live.state.posAt || 0 : 0, typeof Live !== "undefined" ? Live.state.mkAt || 0 : 0);
  a.textContent = App.PAGES ? "actualisé il y a " + ago(last || S.updatedAt) : (App.SNAP ? "données d'il y a " : "mis à jour il y a ") + ago(S.updatedAt); a.classList.toggle("stale", App.PAGES ? Date.now() - (last || 0) > 180e3 : age > (App.SNAP ? 900 : 120));
  if (App.PAGES && typeof Live !== "undefined") { const L = Live.state; $("ages").replaceChildren(...[["Prix (direct)", L.mkAt], ["Positions HL (direct)", L.posAt], ["Analyses GitHub", S.updatedAt], ["Dernière vérification", App.checkedAt]].filter((x) => x[1]).map(([l, t]) => h("div", {}, l + " : ", h("span", { class: "mono" }, ago(t))))); return; }
  $("ages").replaceChildren(...(App.SNAP ? [] : [["Positions HL", S.hl.posAt], ["Prix & funding", S.hl.mkAt], ["Polymarket", S.pm.posAt]].filter((x) => x[1]).map(([l, t]) => h("div", {}, l + " : ", h("span", { class: "mono" }, ago(t))))));
}
/* ---------- bouton Actualiser ---------- */
let toastT;
function toast(msg, kind) { const t = $("toast"); t.textContent = msg; t.className = "toast on " + (kind || ""); clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 4500); }
function modal(title, lines, actions) {
  const m = $("modal"), close = () => (m.hidden = true);
  m.replaceChildren(h("div", { class: "modal-in" }, h("h2", { id: "modalT" }, title), ...lines.map((l) => h("p", {}, l)), h("div", { class: "toolbar", style: "margin-top:16px" }, ...(actions || []), h("button", { class: "btn on", type: "button", onclick: close, id: "modalOk" }, "Compris"))));
  m.onclick = (e) => { if (e.target === m) close(); }; m.onkeydown = (e) => { if (e.key === "Escape") close(); };
  m.hidden = false; $("modalOk").focus();
}
function refreshState(loading) { const b = $("refreshBtn"); b.classList.toggle("loading", loading); b.disabled = loading; $("refreshLbl").textContent = loading ? "Actualisation…" : "Actualiser"; }
let askedAt = 0; try { askedAt = Number(localStorage.getItem("wc-asked") || 0); } catch {}
async function refreshLive() {
  const r = await fetch("/api/refresh", { method: "POST" });
  if (r.status === 429) return toast("Déjà actualisé à l'instant, patientez quelques secondes.");
  if (!r.ok) throw new Error("HTTP " + r.status);
  accept(await r.json()); toast("Données actualisées", "ok");
}
App.PAGES = !!window.__PAGES__;
async function pullState(manual) {
  const r = await fetch("state.json?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json(); App.checkedAt = Date.now();
  const fresh = d.updatedAt > (App.S?.updatedAt || 0);
  if (fresh) accept(typeof Live !== "undefined" ? Live.overlay(d) : d); else tick();
  return fresh;
}
// bouton Actualiser en ligne : prix et positions en direct + dernières analyses GitHub
async function refreshPages() {
  const [fresh] = await Promise.all([pullState(true), typeof Live !== "undefined" ? Live.refreshNow() : null]);
  const ga = App.S ? ago(App.S.updatedAt) : "?";
  toast(fresh ? "Nouvelles analyses chargées · prix et positions à jour" : `Prix et positions à jour · analyses de il y a ${ga} (GitHub les recalcule toutes les 10 à 20 min)`, "ok");
}
async function refreshSnapshot() {
  if (App.PAGES) return refreshPages();
  const c = window.claude?.use ? await window.claude.use("comments").catch(() => null) : null;
  const can = c?.canSendToClaude ? await c.canSendToClaude().catch(() => "off") : "off";
  if (can !== "available") return modal("Cette page est un instantané", [
    "Un navigateur n'a pas le droit d'appeler les API Hyperliquid et Polymarket depuis une page publiée : les données sont figées au moment de la publication.",
    "Pour des données qui bougent en continu, lancez la version locale (node server.mjs). Le bouton Actualiser y recharge tout à la demande, et un flux en direct met à jour la page toutes les quelques secondes.",
    "Dans la conversation avec Claude, vous pouvez aussi demander « actualise l'artefact » : il collecte les données et republie la page.",
  ]);
  try {
    const anchor = await c.anchorFor($("refreshBtn"));
    await c.sendToClaude({ anchor, text: "Actualise les données de la Boussole des baleines : relance la collecte Hyperliquid et Polymarket, puis republie cet artefact avec les données fraîches." });
    askedAt = Date.now(); try { localStorage.setItem("wc-asked", String(askedAt)); } catch {}
    toast("Demande envoyée à Claude. La page se rechargera d'elle-même avec les nouvelles données (1 à 2 minutes).", "ok");
  } catch (e) {
    if (e.code === "consent_required") toast("Autorisez l'envoi de commentaires par la page pour utiliser ce bouton.", "err");
    else if (e.code === "claude_unavailable") modal("Claude ne peut pas recevoir la demande", ["Aucune session Claude n'écoute cet artefact pour le moment. Demandez « actualise l'artefact » dans la conversation, ou utilisez la version locale."]);
    else if (e.code === "rate_limited") toast("Trop de demandes, patientez un instant.", "err"); else toast("L'envoi a échoué (" + (e.code || e.message) + ").", "err");
  }
}
App.requestRefresh = async () => {
  if (App.SNAP && !App.PAGES && Date.now() - askedAt < 90000) return toast("Une demande est déjà en cours : la page se rechargera toute seule.");
  refreshState(true);
  try { await (App.SNAP ? refreshSnapshot() : refreshLive()); } catch (e) { toast("Actualisation impossible : " + (e.message || e), "err"); } finally { refreshState(false); }
};

fold("xasset", "funding", "Funding et open interest", "Qui paie pour garder sa position, et où les baleines sont du même côté que la foule.");
fold("sent", "histo", "Évolution et meilleurs comptes", "Le score dans le temps, et l'avis des 20 meilleurs comptes face aux autres.");
fold("news", "social", "Réseaux en direct", "Canaux Telegram d'alertes, Truth Social, et X une fois branché.");
buildChrome();
window.addEventListener("hashchange", route);
if (App.SNAP) { App.S = App.SNAP; App.firstState = false; }
route();
if (App.SNAP) { accept(App.SNAP); } else {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => { $("dot").classList.add("on"); accept(JSON.parse(e.data)); });
  es.onerror = () => { $("dot").classList.remove("on"); $("liveTxt").textContent = "reconnexion…"; };
}
setInterval(tick, 1000);
Tape.start();   // moteur du Whale Tape : tourne en continu, quelle que soit la page affichée
if (App.PAGES) setInterval(() => { if (!document.hidden) pullState(false).catch(() => {}); }, 60000);
